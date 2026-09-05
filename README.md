# 模型测评台

Windows 本地运行的 Vue 3 + Node 小型测评服务，默认连接 llama-swap 的 OpenAI Compatible 接口。

## 启动

```powershell
cd D:\AI\llm-test
npm install
node server.js
```

然后打开 http://127.0.0.1:3000/ 。第一次在“连接设置”填写协议、端点和 Key，点击“获取模型”；配置会保存在浏览器缓存。

## 测试流程

在“添加测试任务”中填写结果名称和备注，选择一个或多个模型（多选顺序就是执行顺序），设置重复次数，再勾选测试项目。每次重复的结果会自动求平均，首页只显示平均值。当前内置：

- 连通性与吐字速度：实际 Chat Completions 请求，返回是否成功、首 token 延迟和 tok/s。
- GPQA Diamond：本机缓存 198 题，衡量高难度科学推理。
- AIME 2025：本机缓存 30 题，衡量竞赛数学推理。
- MMLU-Pro：本机缓存 12032 题，衡量广泛学科理解（服务 API 已支持，界面任务列表会显示）。

题库原始 parquet 在 `data/`，转换脚本在 `scripts/prepare_cached_tasks.py`；以后可用同样格式新增 JSONL 题库和 `server.js` 中的 task 定义。HF 下载可在 Windows 侧先完成，再把 parquet 放入 `data/` 转换，避免 WSL 网络和 gated 权限问题。

## 说明

这是面向本机可用性的轻量工具，不替换 llama-swap，也不会自动重启或修改其模型配置。运行记录当前保存在 Node 进程内存中；刷新服务后记录会清空，正式长期保存可再接 SQLite。
