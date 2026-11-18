module.exports = req => req.ip || req.socket?.remoteAddress || 'unknown';
