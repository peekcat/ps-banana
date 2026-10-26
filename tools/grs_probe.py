#!/usr/bin/env python3
"""GRS 参考图 base64 兼容性探测。

背景: docs/去云化评估.md §5.1
  现状: GRS + GPT-Image 带图时必须先把图上传到作者临时图床换公网 URL,
        填进旧接口 /v1/draw/completions 的 urls 字段。
  待验证:
    A. 旧接口 urls 直接塞 data:image/...;base64,... 能不能用 (方案 1)
    B. 新接口 POST /v1/api/generate 的 images 字段收 base64 (方案 2)

脚本只依赖标准库 + Pillow(仅用于生成测试图和检查结果图)。
Key 从 --key / 环境变量 GRS_API_KEY / 同目录上级的 .grs-key.txt 读取, 不写日志。

用法:
  python tools/grs_probe.py credits
  python tools/grs_probe.py run --model gpt-image-2-vip --max-images 4
"""
import argparse
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    Image = None

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "docs" / "实机记录" / "grs-probe"
DEFAULT_BASE = "https://grsai.dakka.com.cn"

PROMPT = (
    "Edit the reference image: change the red square to blue (#0000FF). "
    "Keep the white background and the square's exact position and size unchanged. "
    "Flat vector illustration, no text."
)

MULTI_PROMPT = (
    "Combine the two reference images onto one white background: keep the red square "
    "from the first image on the left and the green circle from the second image on the "
    "right. Same colors and sizes, flat vector illustration, no text."
)


def log(msg):
    print(msg, flush=True)


def read_key(args):
    if args.key:
        return args.key.strip()
    env = os.environ.get("GRS_API_KEY", "").strip()
    if env:
        return env
    for p in (ROOT / ".grs-key.txt", Path.cwd() / ".grs-key.txt"):
        if p.is_file():
            t = p.read_text(encoding="utf-8").strip()
            if t:
                return t
    sys.exit("没有 Key: 用 --key、GRS_API_KEY 或 .grs-key.txt 提供")


def http(method, url, key=None, body=None, timeout=120, accept_json=True):
    data = None
    headers = {"Accept": "application/json, text/event-stream, */*"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    ctx = ssl.create_default_context()
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), raw, time.time() - t0
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, dict(e.headers), raw, time.time() - t0
    except Exception as e:  # 网络/超时
        return 0, {}, str(e).encode(), time.time() - t0


def parse_body(raw):
    txt = raw.decode("utf-8", "replace").strip()
    if not txt:
        return None, txt
    try:
        return json.loads(txt), txt
    except ValueError:
        pass
    objs = []
    for line in txt.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                try:
                    objs.append(json.loads(payload))
                except ValueError:
                    pass
    return (objs[-1] if objs else None), txt


class Recorder:
    """把每次请求/响应落盘, 便于事后核对(不记录 Key)。"""

    def __init__(self):
        stamp = time.strftime("%Y-%m-%d_%H%M%S")
        self.dir = OUT_ROOT / stamp
        self.dir.mkdir(parents=True, exist_ok=True)
        self.n = 0

    def save(self, name, obj):
        self.n += 1
        path = self.dir / ("%02d-%s.json" % (self.n, name))
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        return path


def make_test_image(path):
    """640x480 白底 + 红色方块(160,120 到 480,360)。"""
    if Image is None:
        sys.exit("需要 Pillow 生成测试图")
    img = Image.new("RGB", (640, 480), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([160, 120, 479, 359], fill=(255, 0, 0))
    img.save(path)
    return path


def make_test_image2(path):
    """640x480 白底 + 绿色圆形, 用于多参考图测试。"""
    if Image is None:
        sys.exit("需要 Pillow 生成测试图")
    img = Image.new("RGB", (640, 480), "white")
    d = ImageDraw.Draw(img)
    d.ellipse([160, 120, 479, 439], fill=(0, 170, 0))
    img.save(path)
    return path


def inspect_result_image(path, want_green=False):
    """检查结果图里红/蓝/(绿)像素占比, 用来证明参考图确实被用上了。"""
    if Image is None or not path or not Path(path).is_file():
        return None
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.resize((160, 120)).load()
    red = blue = green = white = total = 0
    for y in range(120):
        for x in range(160):
            r, g, b = px[x, y]
            total += 1
            if r > 150 and g < 100 and b < 100:
                red += 1
            elif b > 150 and r < 100 and g < 100:
                blue += 1
            elif g > 110 and r < 110 and b < 110:
                green += 1
            elif r > 220 and g > 220 and b > 220:
                white += 1
    out = {
        "size": [w, h],
        "red_pct": round(red * 100.0 / total, 1),
        "blue_pct": round(blue * 100.0 / total, 1),
        "white_pct": round(white * 100.0 / total, 1),
    }
    if want_green:
        out["green_pct"] = round(green * 100.0 / total, 1)
    return out


def download(url, dest):
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        dest.write_bytes(data)
        return dest
    except Exception as e:
        log("  ! 下载失败: %s" % e)
        return None


def poll_new(base, key, task_id, timeout_s, rec):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        time.sleep(3)
        st, hdr, raw, el = http("GET", "%s/v1/api/result?id=%s" % (base, task_id), key, timeout=60)
        obj, txt = parse_body(raw)
        last = (obj, txt)
        if obj is None:
            log("  poll HTTP %s 非 JSON: %s" % (st, txt[:200]))
            continue
        status = obj.get("status")
        prog = obj.get("progress")
        log("  poll HTTP %s status=%s progress=%s" % (st, status, prog))
        if status in ("succeeded", "failed", "error"):
            rec.save("new_result_final", {"http": st, "obj": obj, "text": txt})
            return obj
    rec.save("new_result_timeout", {"last": last})
    return {"status": "timeout", "raw": last}


def poll_old(base, key, task_id, timeout_s, rec):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        time.sleep(3)
        st, hdr, raw, el = http(
            "POST", "%s/v1/draw/result" % base, key, {"id": task_id}, timeout=60
        )
        obj, txt = parse_body(raw)
        last = (obj, txt)
        if obj is None:
            log("  poll HTTP %s 非 JSON: %s" % (st, txt[:200]))
            continue
        code = obj.get("code")
        data = obj.get("data") or {}
        log("  poll HTTP %s code=%s status=%s progress=%s"
            % (st, code, data.get("status"), data.get("progress")))
        if code != 0:
            rec.save("old_result_error", {"http": st, "obj": obj})
            return obj
        if data.get("status") in ("succeeded", "failed", "error"):
            rec.save("old_result_final", {"http": st, "obj": obj})
            return obj
    rec.save("old_result_timeout", {"last": last})
    return {"timeout": True, "raw": last}


def summarize(obj):
    """把两套接口的返回压成一行关键信息。"""
    if not obj:
        return "空响应"
    data = obj.get("data") if isinstance(obj.get("data"), dict) else obj
    status = data.get("status") or obj.get("status")
    err = data.get("error") or obj.get("error")
    msg = obj.get("msg")
    urls = []
    for r in (data.get("results") or []):
        if isinstance(r, dict) and r.get("url"):
            urls.append(r["url"])
    if isinstance(obj.get("url"), str):
        urls.append(obj["url"])
    bits = []
    if status:
        bits.append("status=%s" % status)
    if data.get("progress") is not None:
        bits.append("progress=%s" % data.get("progress"))
    if err:
        bits.append("error=%s" % err)
    if msg:
        bits.append("msg=%s" % msg)
    if urls:
        bits.append("urls=%d" % len(urls))
    if data.get("failure_reason"):
        bits.append("failure=%s" % data.get("failure_reason"))
    return ", ".join(bits) or json.dumps(obj, ensure_ascii=False)[:300]


def test_new(base, key, model, b64, style, rec, max_poll, aspect):
    """新接口 POST /v1/api/generate, 参考图放 images。style: datauri | raw"""
    image = "data:image/png;base64," + b64 if style == "datauri" else b64
    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [image],
        "aspectRatio": aspect,
        "webHook": "-1",
        "shutProgress": True,
    }
    t0 = time.time()
    st, hdr, raw, el = http("POST", base + "/v1/api/generate", key, payload, timeout=300)
    obj, txt = parse_body(raw)
    rec.save("new_generate_%s" % style, {
        "http": st, "content_type": hdr.get("Content-Type"),
        "body_head": txt[:4000], "elapsed": round(el, 1),
        "images_field_bytes": len(image),
    })
    log("  generate HTTP %s CT=%s %.1fs -> %s" % (st, hdr.get("Content-Type"), el, summarize(obj)))
    if not obj:
        return {"ok": False, "stage": "submit", "http": st, "detail": txt[:800]}
    err = obj.get("error") or (obj.get("data") or {}).get("error")
    if err:
        return {"ok": False, "stage": "submit", "http": st, "detail": err}
    task_id = obj.get("id") or (obj.get("data") or {}).get("id")
    status = obj.get("status") or (obj.get("data") or {}).get("status")
    if not task_id and status not in ("succeeded", "failed"):
        return {"ok": False, "stage": "submit", "http": st, "detail": summarize(obj)}
    if status == "failed":
        return {"ok": False, "stage": "job", "detail": summarize(obj)}
    if status == "succeeded":
        # 新接口是同步的: 提交即返回结果(实测 1K 约 33s), 不需要轮询
        return {"ok": True, "stage": "sync", "obj": obj}
    if not task_id:
        return {"ok": True, "stage": "sync", "obj": obj}
    log("  提交成功, id=%s, 轮询..." % task_id)
    res = poll_new(base, key, task_id, max_poll, rec)
    ok = (res.get("status") == "succeeded")
    return {"ok": ok, "stage": "job", "obj": res, "task_id": task_id,
            "elapsed": round(time.time() - t0, 1)}


def test_new_async(base, key, model, b64, rec, max_poll, aspect):
    """官方新接口的异步模式: replyType=async → POST 返回 id → GET /v1/api/result?id= 轮询。"""
    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": ["data:image/png;base64," + b64],
        "aspectRatio": aspect,
        "replyType": "async",
    }
    t0 = time.time()
    st, hdr, raw, el = http("POST", base + "/v1/api/generate", key, payload, timeout=120)
    obj, txt = parse_body(raw)
    rec.save("new_async_submit", {
        "http": st, "content_type": hdr.get("Content-Type"),
        "body_head": txt[:4000], "elapsed": round(el, 1),
    })
    log("  async 提交 HTTP %s %.1fs -> %s" % (st, el, summarize(obj)))
    if not obj:
        return {"ok": False, "stage": "submit", "http": st, "detail": txt[:800]}
    status = obj.get("status")
    if status in ("failed", "violation"):
        return {"ok": False, "stage": "submit", "detail": summarize(obj)}
    task_id = obj.get("id")
    if not task_id:
        return {"ok": False, "stage": "submit", "detail": summarize(obj)}
    deadline = time.time() + max_poll
    last = None
    while time.time() < deadline:
        time.sleep(3)
        st2, hdr2, raw2, el2 = http(
            "GET", "%s/v1/api/result?id=%s" % (base, task_id), key, timeout=60
        )
        obj2, txt2 = parse_body(raw2)
        last = {"http": st2, "obj": obj2, "text": txt2[:1000]}
        if obj2 is None:
            log("  result HTTP %s 非 JSON: %s" % (st2, txt2[:160]))
            continue
        status2 = obj2.get("status")
        log("  result HTTP %s status=%s progress=%s" % (st2, status2, obj2.get("progress")))
        if status2 in ("succeeded", "failed", "violation"):
            rec.save("new_async_result_final", last)
            return {"ok": status2 == "succeeded", "stage": "job", "obj": obj2,
                    "task_id": task_id, "elapsed": round(time.time() - t0, 1),
                    "detail": summarize(obj2)}
    rec.save("new_async_result_timeout", last)
    return {"ok": False, "stage": "timeout", "detail": "轮询超时"}


def test_old(base, key, model, images, rec, max_poll, aspect, prompt=None, tag="old_generate_b64_urls"):
    """旧接口 POST /v1/draw/completions, 参考图放 urls(直接塞 data URI)。"""
    prompt = prompt or PROMPT
    payload = {
        "model": model,
        "prompt": prompt,
        "aspectRatio": aspect,
        "webHook": "-1",
        "shutProgress": True,
        "urls": ["data:image/png;base64," + b for b in images],
    }
    t0 = time.time()
    st, hdr, raw, el = http("POST", base + "/v1/draw/completions", key, payload, timeout=300)
    obj, txt = parse_body(raw)
    rec.save(tag, {
        "http": st, "content_type": hdr.get("Content-Type"),
        "body_head": txt[:4000], "elapsed": round(el, 1),
        "ref_count": len(images), "prompt": prompt,
    })
    log("  completions HTTP %s %.1fs -> %s" % (st, el, summarize(obj)))
    if not obj:
        return {"ok": False, "stage": "submit", "http": st, "detail": txt[:800]}
    if obj.get("code") != 0:
        return {"ok": False, "stage": "submit", "detail": summarize(obj)}
    task_id = (obj.get("data") or {}).get("id")
    if not task_id:
        return {"ok": False, "stage": "submit", "detail": summarize(obj)}
    log("  提交成功, id=%s, 轮询..." % task_id)
    res = poll_old(base, key, task_id, max_poll, rec)
    data = res.get("data") or {}
    ok = data.get("status") == "succeeded"
    return {"ok": ok, "stage": "job", "obj": res, "task_id": task_id,
            "elapsed": round(time.time() - t0, 1)}


def extract_first_url(obj):
    if not obj:
        return None
    data = obj.get("data") if isinstance(obj.get("data"), dict) else obj
    for r in (data.get("results") or []):
        if isinstance(r, dict) and r.get("url"):
            return r["url"]
    return data.get("url") or obj.get("url")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["credits", "run"])
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--model", default="gpt-image-2-vip")
    ap.add_argument("--aspect", default="1024x1024")
    ap.add_argument("--max-images", type=int, default=4, help="最多提交几个会出图的请求")
    ap.add_argument("--poll", type=int, default=600, help="单任务最长轮询秒数")
    ap.add_argument("--key", default="")
    ap.add_argument("--only", default="", help="逗号分隔: new,old (默认都跑)")
    ap.add_argument("--no-raw-fallback", action="store_true",
                    help="新接口 data URI 失败时不重试纯 base64")
    args = ap.parse_args()

    key = read_key(args)
    base = args.base.rstrip("/")
    rec = Recorder()
    log("base=%s model=%s 输出目录=%s" % (base, args.model, rec.dir))

    # 插件里的余额查询: POST /client/openapi/getAPIKeyCredits, body {apiKey}
    st, hdr, raw, el = http(
        "POST", base + "/client/openapi/getAPIKeyCredits", None,
        {"apiKey": key}, timeout=30,
    )
    obj, txt = parse_body(raw)
    rec.save("credits_post", {"http": st, "content_type": hdr.get("Content-Type"),
                              "body": txt[:2000]})
    credits = None
    if obj and obj.get("code") == 0 and obj.get("data"):
        credits = obj["data"].get("credits")
    if st != 200 or credits is None:
        # 兼容 GET + Bearer 的旧查法
        st2, hdr2, raw2, el2 = http(
            "GET", base + "/client/openapi/getAPIKeyCredits", key, timeout=30
        )
        obj2, txt2 = parse_body(raw2)
        rec.save("credits_get", {"http": st2, "body": txt2[:2000]})
        if obj2 and obj2.get("code") == 0 and obj2.get("data"):
            obj, st, credits = obj2, st2, obj2["data"].get("credits")
    log("积分余额查询: HTTP %s -> %s" % (st, summarize(obj) if obj else txt[:200]))
    if credits is not None:
        log("余额: %s 积分" % credits)
    if st != 200 or (obj and obj.get("code") not in (0, None)):
        log("警告: 余额查询没有成功, Key 可能无效或线路不对")

    if args.mode == "credits":
        return

    img_path = make_test_image(rec.dir / "input-red-square.png")
    b64 = base64.b64encode(img_path.read_bytes()).decode()
    log("测试图: %s (%.1f KB, base64 %.1f KB)"
        % (img_path, img_path.stat().st_size / 1024, len(b64) / 1024))

    results = {}
    budget = {"left": max(0, args.max_images)}

    def take():
        if budget["left"] <= 0:
            return False
        budget["left"] -= 1
        return True

    want = [x.strip() for x in (args.only or "new,old").split(",") if x.strip()]
    if "new" in want and take():
        log("\n[1] 新接口 /v1/api/generate, images = data URI")
        r = test_new(base, key, args.model, b64, "datauri", rec, args.poll, args.aspect)
        r["url"] = extract_first_url(r.get("obj"))
        results["new_b64_datauri"] = r
        log("  结果: %s" % ("成功" if r.get("ok") else "失败 " + str(r.get("detail"))[:300]))
        if r.get("url"):
            p = download(r["url"], rec.dir / "result-new-datauri.png")
            r["saved"] = str(p) if p else None
            r["pixels"] = inspect_result_image(p)
            log("  像素检查: %s" % r["pixels"])

        if not r.get("ok") and not args.no_raw_fallback and take():
            log("\n[2] 新接口重试, images = 纯 base64(不带 data: 前缀)")
            r2 = test_new(base, key, args.model, b64, "raw", rec, args.poll, args.aspect)
            r2["url"] = extract_first_url(r2.get("obj"))
            results["new_b64_raw"] = r2
            log("  结果: %s" % ("成功" if r2.get("ok") else "失败 " + str(r2.get("detail"))[:300]))
            if r2.get("url"):
                p = download(r2["url"], rec.dir / "result-new-raw.png")
                r2["saved"] = str(p) if p else None
                r2["pixels"] = inspect_result_image(p)

    if "async" in want and take():
        log("\n[5] 官方新接口 replyType=async + base64 (验证异步轮询链路)")
        r = test_new_async(base, key, args.model, b64, rec, args.poll, args.aspect)
        r["url"] = extract_first_url(r.get("obj"))
        results["new_async_b64"] = r
        log("  结果: %s" % ("成功" if r.get("ok") else "失败 " + str(r.get("detail"))[:300]))
        if r.get("url"):
            p = download(r["url"], rec.dir / "result-new-async.png")
            r["saved"] = str(p) if p else None
            r["pixels"] = inspect_result_image(p)
            log("  像素检查: %s" % r["pixels"])

    if "old" in want and take():
        log("\n[3] 旧接口 /v1/draw/completions, urls = data URI")
        r = test_old(base, key, args.model, [b64], rec, args.poll, args.aspect)
        r["url"] = extract_first_url(r.get("obj"))
        results["old_b64_datauri"] = r
        log("  结果: %s" % ("成功" if r.get("ok") else "失败 " + str(r.get("detail"))[:300]))
        if r.get("url"):
            p = download(r["url"], rec.dir / "result-old-datauri.png")
            r["saved"] = str(p) if p else None
            r["pixels"] = inspect_result_image(p)
            log("  像素检查: %s" % r["pixels"])

    if "multi" in want and take():
        log("\n[4] 旧接口, 两张参考图都是 data URI (插件实际会传主图+参考图)")
        img2 = make_test_image2(rec.dir / "input-green-circle.png")
        b64_2 = base64.b64encode(img2.read_bytes()).decode()
        r = test_old(
            base, key, args.model, [b64, b64_2], rec, args.poll, args.aspect,
            prompt=MULTI_PROMPT, tag="old_multi_b64_urls",
        )
        r["url"] = extract_first_url(r.get("obj"))
        results["old_multi_b64"] = r
        log("  结果: %s" % ("成功" if r.get("ok") else "失败 " + str(r.get("detail"))[:300]))
        if r.get("url"):
            p = download(r["url"], rec.dir / "result-old-multi.png")
            r["saved"] = str(p) if p else None
            r["pixels"] = inspect_result_image(p, want_green=True)
            log("  像素检查(应同时出现红与绿): %s" % r["pixels"])

    summary = {
        "base": base,
        "model": args.model,
        "credits_before": credits,
        "results": {k: {kk: vv for kk, vv in v.items() if kk != "obj"} for k, v in results.items()},
        "raw": {k: v.get("obj") for k, v in results.items()},
    }
    (rec.dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log("\n完成。汇总: %s" % (rec.dir / "summary.json"))


if __name__ == "__main__":
    main()
