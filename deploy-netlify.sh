#!/bin/bash
# Netlify 出桶部署脚本：建站 + zip 部署（含 edge-functions 源码，buildbot 自动打包）。
# 用法：NETLIFY_TOKEN=nfp_xxx bash deploy-netlify.sh [站点名]
# 国内网络走 Clash 混合端口 7897（api.netlify.com 直连不通时的唯一路径）。
set -e
T="${NETLIFY_TOKEN:?需要 NETLIFY_TOKEN}"
SITE="${1:-muse-egress-netlify}"
PROXY="http://127.0.0.1:7897"
C="curl -sS --proxy $PROXY"
API="https://api.netlify.com/api/v1"
AUTH="Authorization: Bearer $T"

echo "[1/4] 建/取站点 $SITE"
SITE_JSON=$($C -X POST "$API/sites" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"name\":\"$SITE\"}")
SITE_ID=$(echo "$SITE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.id)console.log(j.id);else{console.error(s);process.exit(1)}})")
SSL_URL=$(echo "$SITE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ssl_url||''))")
echo "  site_id=$SITE_ID url=$SSL_URL"

echo "[2/4] 打包 netlify/ 目录"
cd "$(dirname "$0")"
rm -f deploy.zip
powershell -NoProfile -Command "Compress-Archive -Path 'netlify' -DestinationPath 'deploy.zip' -Force"
ls -la deploy.zip

echo "[3/4] zip 部署"
DEP_JSON=$($C -X POST "$API/sites/$SITE_ID/deploys" -H "$AUTH" -F "file=@deploy.zip")
DEP_ID=$(echo "$DEP_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.id)console.log(j.id);else{console.error(s);process.exit(1)}})")
echo "  deploy_id=$DEP_ID"

echo "[4/4] 轮询部署状态（最长 180s）"
for i in $(seq 1 36); do
  sleep 5
  ST=$($C "$API/deploys/$DEP_ID" -H "$AUTH" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).state))")
  echo "  [$((i*5))s] $ST"
  [ "$ST" = "ready" ] && break
  case "$ST" in error|expired) echo "部署失败: $ST"; exit 1;; esac
done
echo "完成：$SSL_URL （/geo 看出口，/v1/* 代理）"
