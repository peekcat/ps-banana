// 并发池: 限制最大并行数 + 错峰启动。
// launchGapMs: 任意两次"发起请求"之间至少间隔(默认 120ms)。同时在跑的仍最多 maxConcurrency 个,
//   但绝不让多条请求在同一刹那一起建连/解析 DNS —— 那种扎堆在代理(Clash)环境下常导致
//   前几条 "Network request failed"。即使 maxConcurrency 远大于任务数(任务一个个 add 进来),
//   也用"上次启动时间 + 最小间隔"强制错峰。
function createConcurrencyPool(maxConcurrency, launchGapMs) {
    var gap = (launchGapMs == null) ? 120 : launchGapMs;
    var running = 0;
    var queue = [];
    var lastStartAt = 0;   // 上一次发起请求的时刻
    var pending = false;   // 是否已有"下一次启动"的定时器在等

    function startOne() {
        var next = queue.shift();
        running++;
        lastStartAt = Date.now();
        next.fn().then(function(result) {
            running--;
            next.resolve(result);
            tryNext();
        }).catch(function(err) {
            running--;
            next.reject(err);
            tryNext();
        });
    }

    function tryNext() {
        if (running >= maxConcurrency || queue.length === 0) return;
        if (gap <= 0) {
            while (running < maxConcurrency && queue.length > 0) startOne();
            return;
        }
        if (pending) return;   // 已有定时器在等下一次启动
        var wait = gap - (Date.now() - lastStartAt);
        if (wait <= 0) {
            startOne();
            tryNext();          // 看还能不能再排下一个(会走到上面的 wait>0 分支去等)
        } else {
            pending = true;
            setTimeout(function() { pending = false; tryNext(); }, wait);
        }
    }

    return {
        add: function(fn) {
            return new Promise(function(resolve, reject) {
                queue.push({ fn: fn, resolve: resolve, reject: reject });
                tryNext();
            });
        }
    };
}

module.exports = {
    createConcurrencyPool: createConcurrencyPool
};
