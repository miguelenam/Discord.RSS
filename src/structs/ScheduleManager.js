const Base = require('./db/Base.js')
const ScheduleRun = require('./ScheduleRun.js')
const createLogger = require('../util/logger/create.js')
const EventEmitter = require('events').EventEmitter
const getConfig = require('../config.js').get

/**
 * @typedef {string} FeedURL
 */

/**
 * @typedef {Object<FeedURL, Object<string, any>[]>} MemoryCollection
 */

class ScheduleManager extends EventEmitter {
  constructor () {
    super()
    this.log = createLogger('M')
    this.timers = []
    /**
     * @type {Set<string>}
     */
    this.debugFeedIDs = new Set()
    /**
     * @type {import('./db/Schedule.js')[]}
     * */
    this.schedules = []
    /**
     * @type {import('./ScheduleRun.js')[]}
     * */
    this.scheduleRuns = []
    /**
     * @type {Map<import('./db/Schedule.js'), number>}
     */
    this.scheduleRunCounts = new Map()
    /**
     * @type {Map<import('./db/Schedule.js'), MemoryCollection>}
     * */
    this.memoryCollections = new Map() // by schedule
    /**
     * @type {Map<import('./db/Schedule.js'), Object<string, any>}
     * */
    this.headers = new Map() // by schedule
  }

  async _onPendingArticle (pendingArticle) {
    const article = pendingArticle.article
    if (this.debugFeedIDs.has(article._feed._id)) {
      this.log.debug(`${article._feed._id} ScheduleManager queueing article ${article.link} to send`)
    }
    this.emit('pendingArticle', pendingArticle)
  }

  /**
   * Add a schedule and initialize relevant data for it
   *
   * @param {import('./db/Schedule.js')} schedule
   */
  addSchedule (schedule) {
    this.schedules.push(schedule)
    this.scheduleRunCounts.set(schedule, 0)
    if (Base.isMongoDatabase) {
      this.memoryCollections.set(schedule, {})
    }
    this.headers.set(schedule, {})
  }

  /**
   * Add multiple schedules
   *
   * @param {import('./db/Schedule.js')[]} schedules
   */
  addSchedules (schedules) {
    for (const schedule of schedules) {
      this.addSchedule(schedule)
    }
  }

  /**
   * Get current schedule runs of a schedule
   *
   * @param {import('./db/Schedule.js')} schedule
   */
  getRuns (schedule) {
    return this.scheduleRuns.filter(r => r.schedule === schedule)
  }

  /**
   * Terminate a run by killing its children, removing
   * listeners and deleting it from storage
   *
   * @param {import('./ScheduleRun.js')} run
   */
  terminateRun (run) {
    run.terminate()
    run.removeAllListeners()
    this.scheduleRuns.splice(this.scheduleRuns.indexOf(run), 1)
  }

  /**
   * Terminate multiple runs
   *
   * @param {import('./db/Schedule.js')} schedule
   */
  terminateScheduleRuns (schedule) {
    const runs = this.getRuns(schedule)
    runs.forEach(r => this.terminateRun(r))
  }

  /**
   * Check if the number of current runs of a schedule
   * exceeds the max allowed
   *
   * @param {import('./db/Schedule')} schedule
   */
  atMaxRuns (schedule) {
    const maxRuns = getConfig().advanced.parallelRuns
    const runs = this.getRuns(schedule)
    return runs.length === maxRuns
  }

  /**
   * Increment run count of a schedule
   *
   * @param {import('./db/Schedule.js')} schedule
   */
  incrementRunCount (schedule) {
    const counts = this.scheduleRunCounts
    counts.set(schedule, counts.get(schedule) + 1)
  }

  /**
   * Run a schedule
   *
   * @param {import('./db/Schedule.js')} schedule
   */
  run (schedule) { // Run schedules with respect to their refresh times
    if (this.atMaxRuns(schedule)) {
      const runCount = this.getRuns(schedule).length
      this.log.warn(`Previous schedule runs were not finished (${runCount} run(s)). Terminating all runs. If repeatedly seeing this message, consider increasing your refresh rate.`)
      this.terminateScheduleRuns(schedule)
    }
    const runCount = this.scheduleRunCounts.get(schedule)
    const memoryCollection = this.memoryCollections.get(schedule)
    const headers = this.headers.get(schedule)
    const run = new ScheduleRun(schedule, runCount, memoryCollection, headers)
    run.once('finish', () => {
      this.terminateRun(run)
      this.incrementRunCount(schedule)
    })
    run.on('pendingArticle', this._onPendingArticle.bind(this))
    this.scheduleRuns.push(run)
    run.run(this.debugFeedIDs)
  }

  /**
   * Disable all schedule timers
   */
  clearTimers () {
    if (this.timers.length === 0) {
      return
    }
    this.timers.forEach(timer => clearInterval(timer))
    this.timers.length = 0
  }

  /**
   * Create auto-running schedule timers
   */
  beginTimers () {
    this.clearTimers()
    // const rates = new Set()
    this.schedules.forEach(schedule => {
      this.run(schedule)
      this.timers.push(setInterval(() => {
        this.run(schedule)
      }, schedule.refreshRateMinutes * 60000))
    })
  }

  addDebugFeedID (feedID) {
    this.debugFeedIDs.add(feedID)
  }

  removeDebugFeedID (feedID) {
    this.debugFeedIDs.delete(feedID)
  }

  isDebugging (feedID) {
    return this.debugFeedIDs.has(feedID)
  }
}

module.exports = ScheduleManager
