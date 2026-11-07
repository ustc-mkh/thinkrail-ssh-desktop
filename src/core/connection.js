import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Gateway } from './gateway.js';
import { SshSession, probeHealth } from './ssh.js';

export class Connection extends EventEmitter {
  constructor(profile, { askpass, sessionFactory, probe = probeHealth, retryBase = 1000, healthInterval = 15000 } = {}) {
    super();
    this.profile = profile;
    this.gateway = new Gateway();
    this.makeSession = sessionFactory || (() => new SshSession(profile, { askpass }));
    this.probe = probe;
    this.retryBase = retryBase;
    this.healthInterval = healthInterval;
    this.abort = new AbortController();
    this.state = { status: 'disconnected', stage: '', error: '', host: profile.host, attempts: 0 };
    this.wasReady = false;
  }

  update(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }

  async start() {
    try { await this.gateway.listen(this.profile.localPort); }
    catch (error) {
      if (error.code === 'EADDRINUSE') throw new Error('此配置的本地地址被其他程序占用。关闭占用程序，或在高级设置中重置本地地址。');
      throw error;
    }
    this.profile.localPort = this.gateway.port;
    this.loopTask = this.loop().catch(error => {
      if (!this.abort.signal.aborted) this.update({ status: 'error', stage: '连接失败', error: error.message });
    });
    return this.gateway.origin;
  }

  async loop() {
    const signal = this.abort.signal;
    let failures = 0;
    while (!signal.aborted) {
      const session = this.makeSession();
      this.session = session;
      session.on('log', line => this.emit('log', line));
      let lostReason = '';
      const lost = new Promise(resolve => session.once('close', reason => {
        lostReason = reason;
        if (this.session === session) this.gateway.setTarget(null);
        resolve();
      }));
      try {
        this.update({ status: this.wasReady ? 'recovering' : 'connecting', stage: '正在连接 SSH…', error: '', attempts: failures });
        const startedAt = Date.now();
        const port = await session.open(signal);
        this.update({ stage: '正在检查远端 Thinkrail…' });
        let ready = false;
        try { ready = await this.probe(port, { signal }); }
        catch (error) { if (['WRONG_SERVICE', 'SERVICE_UNRESPONSIVE'].includes(error.code)) throw error; }
        if (!ready && this.profile.autoStart) {
          if (session.closed || signal.aborted) throw new Error(lostReason || '连接已取消');
          this.update({ stage: '正在启动远端 Thinkrail…' });
          await session.startHost(signal);
          const deadline = Date.now() + 60000;
          while (!signal.aborted && !session.closed && Date.now() < deadline) {
            try { ready = await this.probe(port, { signal }); if (ready) break; }
            catch (error) { if (error.code === 'WRONG_SERVICE') throw error; }
            await delay(500, undefined, { signal });
          }
        }
        if (!ready) throw new Error('远端 Thinkrail 未就绪。请检查端口、可执行文件路径及远端启动日志。');
        if (signal.aborted || session.closed) throw new Error(lostReason || '连接已取消');
        this.gateway.setTarget(port);
        this.wasReady = true;
        this.update({ status: 'connected', stage: '已连接', error: '', durationMs: Date.now() - startedAt, attempts: 0 });
        this.emit('ready', this.gateway.origin);
        // Slow backend != dead SSH. Keep the page and process; never restart the agent on a health timeout.
        this.healthTimer = setInterval(async () => {
          if (this.checking || signal.aborted || this.session !== session) return;
          this.checking = true;
          try {
            await this.probe(port, { signal });
            if (this.session === session && !session.closed) this.update({ stage: '已连接', error: '' });
          } catch {
            if (this.session === session && !session.closed) this.update({ stage: '等待远端响应…', error: 'SSH 仍连接，远端服务暂未响应' });
          } finally { this.checking = false; }
        }, this.healthInterval);
        await lost;
        clearInterval(this.healthTimer);
        failures = Date.now() - startedAt > 30000 ? 0 : failures;
        throw new Error(lostReason || 'SSH 连接中断');
      } catch (error) {
        clearInterval(this.healthTimer);
        session.close();
        this.gateway.setTarget(null);
        if (signal.aborted) return;
        // Initial config/auth failures should not repeatedly prompt for passwords.
        if (!this.wasReady || /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(error.message)) {
          this.update({ status: 'error', stage: '连接失败', error: error.message });
          return;
        }
        failures++;
        const wait = Math.min(this.retryBase * 2 ** Math.min(failures - 1, 4), 15000) + Math.floor(Math.random() * 300);
        this.update({ status: 'recovering', stage: `${Math.ceil(wait / 1000)} 秒后重新连接…`, error: error.message, attempts: failures });
        await delay(wait, undefined, { signal }).catch(() => {});
      }
    }
  }

  retryNow() {
    // Closing our SSH process wakes the loop without refreshing the Thinkrail page.
    this.session?.close();
  }

  cancelAuthentication() {
    this.abort.abort();
    clearInterval(this.healthTimer);
    this.session?.close();
    this.gateway.setTarget(null);
    this.update({ status: 'error', stage: '认证已取消', error: 'SSH 认证已取消，可重新点击连接。' });
  }

  async stop() {
    this.abort.abort();
    clearInterval(this.healthTimer);
    this.session?.close();
    await this.loopTask;
    await this.gateway.close();
    this.update({ status: 'disconnected', stage: '已断开', error: '' });
  }
}
