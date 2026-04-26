'use strict';

function notFoundHandler(req, res) {
  if (req.path.startsWith('/v1') || req.path === '/health') {
    return res.status(404).json({ error: 'not found' });
  }
  return res.status(404).send('Not found');
}

module.exports = notFoundHandler;
