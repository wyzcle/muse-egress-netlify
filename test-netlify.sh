#!/bin/bash
# Netlify 出桶四步测试协议（6448 视角：走 Clash 7897 过墙）。
# 用法：bash test-netlify.sh https://muse-egress-netlify.netlify.app
set -e
BASE="${1:?需要站点 URL}"
PROXY="http://127.0.0.1:7897"
UA="opencode/1.17.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13"
SES="ses_test_$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')$(date +%s)"
MSG="msg_test_$(date +%s)"
C="curl -sS --proxy $PROXY --max-time 120"

echo "===== [1/4] 出口 geo（edge 函数的 outbound egress IP）====="
$C "$BASE/geo"
echo

echo "===== [1b] 模型列表（取真实模型 id）====="
MODELS=$($C "$BASE/v1/models" -H "x-opencode-session: $SES" -H "x-opencode-request: $MSG")
echo "$MODELS" | head -c 600
echo
MUSE=$(echo "$MODELS" | grep -oE '"(muse-spark-[0-9.]+[^"]*)"' | head -1 | tr -d '"')
NONMUSE=$(echo "$MODELS" | grep -oE '"[a-z0-9._-]*free"' | grep -v muse | head -1 | tr -d '"')
echo "选 muse=$MUSE  非muse=$NONMUSE"

echo "===== [2/4] muse 地域门（非流 responses，200=美国出口过门）====="
$C -X POST "$BASE/v1/responses" \
  -H "Authorization: Bearer public" -H "User-Agent: $UA" -H "Content-Type: application/json" \
  -H "x-opencode-session: $SES" -H "x-opencode-request: $MSG" \
  -d "{\"model\":\"$MUSE\",\"input\":\"只回复两个字：出口\",\"stream\":false,\"max_output_tokens\":1024,\"reasoning\":{\"effort\":\"low\"}}" \
  | head -c 500
echo

echo "===== [3/4] 非 muse 模型（池干净度：429 FreeUsageLimit=脏，200=净）====="
$C -X POST "$BASE/v1/responses" \
  -H "Authorization: Bearer public" -H "User-Agent: $UA" -H "Content-Type: application/json" \
  -H "x-opencode-session: $SES" -H "x-opencode-request: $MSG" \
  -d "{\"model\":\"$NONMUSE\",\"input\":\"只回复两个字：干净\",\"stream\":false,\"max_output_tokens\":512}" \
  | head -c 500
echo

echo "===== [4/4] SSE 长流（muse 流式：数事件帧+耗时，验证流式与保活）====="
T0=$(date +%s)
$C -N -X POST "$BASE/v1/responses" \
  -H "Authorization: Bearer public" -H "User-Agent: $UA" -H "Content-Type: application/json" \
  -H "x-opencode-session: $SES" -H "x-opencode-request: $MSG" \
  -d "{\"model\":\"$MUSE\",\"input\":\"用三句话介绍你自己\",\"stream\":true,\"max_output_tokens\":4096,\"reasoning\":{\"effort\":\"low\"}}" \
  > /tmp/nl_sse.txt
T1=$(date +%s)
echo "事件帧数: $(grep -c '^event:' /tmp/nl_sse.txt)  正文帧: $(grep -c 'output_text.delta' /tmp/nl_sse.txt)  错误帧: $(grep -c '"type":"error"' /tmp/nl_sse.txt)  耗时: $((T1-T0))s"
tail -c 300 /tmp/nl_sse.txt
echo
echo "===== 完成 ====="
