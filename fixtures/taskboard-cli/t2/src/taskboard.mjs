export function listTasks(tasks, {status, before} = {}) {
  return tasks.filter(task => (!status || task.status === status) && (!before || task.due < before));
}
export function stats(tasks) {
  return {total: tasks.length, done: tasks.filter(task => task.status === 'done').length};
}
