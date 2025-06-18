const r = require('express').Router();
const c = require('../controllers/taskController');

r.post('/', c.create);                 // POST   /api/tasks
r.get('/', c.list);                   // GET    /api/tasks
r.get('/:id', c.list);                 // GET    /api/tasks/:id
r.put('/:id/pause', c.pause);         // PUT    /api/tasks/:id/pause
r.put('/:id/resume', c.resume);        // PUT    /api/tasks/:id/resume
r.put('/:id/restart', c.restart);      // PUT    /api/tasks/:id/restart (DI 입력과 동일한 동작)
r.delete('/:id', c.cancel);        // DELETE /api/tasks/:id

module.exports = r;
