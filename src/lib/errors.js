class PastSequenceError extends Error {
  constructor() {
    super(...arguments)
    this.name = 'PastSequenceError'
  }
}

module.exports = {
  PastSequenceError
}
