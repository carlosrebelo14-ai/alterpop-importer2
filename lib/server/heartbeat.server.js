const INTERVAL_MS = 30_000;

if (!global.__alterpopHeartbeatStarted) {
  global.__alterpopHeartbeatStarted = true;

  const logAlive = () => {
    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    console.log(
      `[heartbeat] Servidor vivo (heap=${heapMb}MB rss=${rssMb}MB pid=${process.pid})`
    );
  };

  logAlive();
  setInterval(logAlive, INTERVAL_MS).unref?.();
}
