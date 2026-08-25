// Bun must avoid cpu-features' Node/NAN addon; ssh2 continues with JavaScript fallback.
module.exports = function cpuFeatures() {
    return {}
}
