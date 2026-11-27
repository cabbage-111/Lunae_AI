终端1:

cd /Users/mynela.miao/Desktop/test_frame/LDCai/eigent-main/backend
unset EIGENT_LOCAL_CONTROL_CAPABILITY
EIGENT_LOCAL_BROWSER_AUTH=1 EIGENT_LOCAL_BROWSER_AUTOPAIR=1 uv run python main.py

# 等这一行出现：
# Browser control auth enabled. Pair the web UI once:
#   e.g. http://localhost:5173/?localControlToken=lc1....


终端2:

# ① 启动 Docker 虚拟机（开机后一次即可）
colima start

# ② 起后端全套（在 server 目录）
cd /Users/mynela.miao/Desktop/test_frame/LDCai/eigent-main/server
docker compose up -d

# ③ 验证后端活了
curl -f http://localhost:3001/health && echo "后端 OK"


# ④ 回项目根目录起前端
cd /Users/mynela.miao/Desktop/test_frame/LDCai/eigent-main
npm run dev:web


# 查看库容器
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i postgres

# 进入库
docker exec -it eigent_postgres psql -U postgres -d eigent


