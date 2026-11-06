// A process that ends 300 ms after it starts, whatever its arguments: one that is gone by the time
// dev-run's read of its start time comes back.
setTimeout(() => process.exit(0), 300)
