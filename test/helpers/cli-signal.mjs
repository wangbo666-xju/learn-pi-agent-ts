// Windows 无法用 child.kill('SIGINT') 模拟可捕获的信号；通过 IPC 触发进程处理器。
// 此文件只由子进程测试预加载，不进入应用代码。
process.on('message', (message) => {
    if (message === 'SIGINT') process.emit('SIGINT');
});
process.channel?.unref();
