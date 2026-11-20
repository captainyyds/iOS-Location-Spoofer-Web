# 德国服务器部署

访问地址：https://gps.x-cipher.com/

当前状态：**已按用户要求暂停**。Node.js 服务已停止并关闭开机自启，HTTPS 入口返回 503 暂停提示；源码、密码、坐标、收藏和证书保留。恢复网页不代表手机定位改写问题已修复。

源仓库：https://github.com/captainyyds/iOS-Location-Spoofer-Web

上游版本：`13e59f56803d25604cefbcbb9cf5a78dd13b65d8`。

原作者：https://github.com/akudamatata/iOS-Location-Spoofer-Web 。沿用 CC BY-NC-SA 4.0 授权，保留原项目署名和声明。

## 架构

原版是 Cloudflare Pages Functions + KV，服务器版使用 Node.js 22 自带的 HTTP / Fetch API，直接复用原有 Functions 处理定位和收藏。没有新增 npm 依赖。`server.mjs` 替代 Cloudflare 的静态资源配置注入与模块生成，并使用本地 JSON 存储模拟 KV。

所有 API 操作串行执行，写入经 fsync 后原子替换，避免并发请求覆盖收藏。收藏 ID 改为 UUID。定位 API、收藏 API 和 Shadowrocket 模块都校验 Token；首页只包含是否需要密码，不包含密码。服务拒绝以空密码启动。修复前端零经纬度的回读和搜索结果 HTML 转义。

浏览器实测原版 CARTO 底图已经要求 API Key，因此国际底图改用 OpenStreetMap 标准瓦片。遵循 [OSMF 瓦片使用要求](https://operations.osmfoundation.org/policies/tiles/)：浏览器直连、正常缓存、发送来源站点、可见署名，不提供预下载。采用 `strict-origin-when-cross-origin`，跨站请求只发送站点来源，不发送含 Token 的路径与查询。顺带修复卫星地图收藏跳转和图层切换后标记偏移。

## 服务器路径

- SSH：`ssh de`（43.131.39.3）。
- 发布版本：`/opt/ios-location-spoofer/releases/`。
- 当前版本：`/opt/ios-location-spoofer/current`，符号链接。
- 配置与密码：`/etc/ios-location-spoofer.env`，root 可读。
- 运行用户：`gps-spoofer`。
- 定位与收藏：`/var/lib/ios-location-spoofer/store.json`。
- 服务：`ios-location-spoofer.service`，仅监听 `127.0.0.1:8091`。
- Nginx：`/www/server/panel/vhost/nginx/gps.x-cipher.com.conf`。
- HTTPS 证书：`/www/server/panel/vhost/cert/gps.x-cipher.com/`。
- 证书续期：复用 `/usr/local/sbin/codex-acme-renew.sh` 的现有定时任务。

Nginx 关闭该站点访问日志和代理缓存，避免记录 URL 中的 Token 或缓存坐标。其他站点配置保持原样。

## 日常管理

```sh
ssh de 'systemctl status ios-location-spoofer --no-pager'
ssh de 'journalctl -u ios-location-spoofer -n 50 --no-pager'
ssh de 'bash /opt/ios-location-spoofer/current/deploy/manage-service.sh status'
```

恢复现有服务器（仅在需要重新启用时执行）：

```sh
ssh de 'bash /opt/ios-location-spoofer/current/deploy/manage-service.sh resume'
```

暂停并保留数据：

```sh
ssh de 'bash /opt/ios-location-spoofer/current/deploy/manage-service.sh pause'
```

更改密码：编辑服务器 `/etc/ios-location-spoofer.env` 中 `TOKEN`，重启服务，随后在手机重新登录并重新导入模块。可选高德搜索 Key 通过 `AMAP_KEY` 配置；未配置时使用 OpenStreetMap 搜索。

本机 `.env` 是首次部署的私有配置副本，已在 `.gitignore` 排除，不要提交或分享。

## 更新与回滚

先在本地执行 `npm test`。上传完整源代码至一个新的 releases 子目录；不要上传 `.env`、`data/` 或 `.git/`。用服务器 Node.js 运行该目录的测试后，将 `current` 切换至新目录，重启服务并验证 `/healthz`、密码验证和模块地址。失败时将 `current` 切回上一版本并重启；数据目录独立，不随版本切换。

部署前备份 `/var/lib/ios-location-spoofer/store.json` 和 `/etc/ios-location-spoofer.env`，备份须限制读取权限。

## 从 Git 重新安装

以下步骤针对已配置 Node.js 22、Nginx、域名及证书路径的同类 Linux 服务器，使用 root 执行。新服务器先按实际域名和 Nginx 布局修改 `deploy/` 中的配置。

```sh
git clone https://github.com/captainyyds/iOS-Location-Spoofer-Web.git /root/ios-location-spoofer-source
cd /root/ios-location-spoofer-source
npm test
```

将代码复制到新的 `/opt/ios-location-spoofer/releases/<版本号>/` 目录，再建立 `current` 链接。首次安装时创建 `gps-spoofer` 系统用户，安装 `deploy/ios-location-spoofer.service` 到 `/etc/systemd/system/`，执行 `systemctl daemon-reload`。若 Node 不在 `/usr/local/bin/node`，先修改服务文件中的路径。

首次安装复制 `.env.example` 到 `/etc/ios-location-spoofer.env`，将 `TOKEN` 替换为随机密码（可用 `openssl rand -hex 24` 生成），填写 `PUBLIC_URL` 并设权限为 `600`。重新部署已有服务器时沿用原配置；不要用模板覆盖原密码。系统服务自动创建独立的数据目录。

确认 Nginx HTTPS 证书和 HTTP 验证目录就绪后，运行 `bash deploy/manage-service.sh resume` 启用。只归档代码、保持暂停时无需执行 resume。

仓库不保存真实 `.env`、坐标/收藏数据、证书私钥或手机诊断日志，这些内容需单独保管。

## 手机使用

1. 用 Safari 打开站点，输入 Token 登录。
2. 在设置中点击导入 Shadowrocket 模块，或复制模块链接到 Shadowrocket 的“配置 → 模块”。
3. 按原项目说明开启 HTTPS 解密、生成并安装 Shadowrocket CA，在 iOS 证书信任设置中信任它。
4. 启用模块与 Shadowrocket，回面板选点并锁定，再关闭定位服务约 10 秒后重新开启。

服务端验收不能替代 iPhone 实测。项目通过改写 Apple 定位网络响应工作；设备系统限制、证书固定、GPS 等其他定位来源都可能影响结果。README 的版本兼容性声明不是本次部署实测结论。

## 本次验收（2026-11-20）

- 当前发布：`20261120-13e59f5-r2`。
- 本机与服务器 Node.js 均通过 3 项集成测试，包括并发收藏与发布目录链接启动。
- 公网 HTTPS 验证正常，证书有效期至 2027-02-18，已记录到现有 acme.sh 自动续期配置。
- 未携带密码时，定位、收藏、登录验证与模块下载接口均返回 401。
- 在线保存临时坐标与收藏后重启服务，确认数据仍在；测试后恢复原坐标并移除临时收藏。
- 浏览器已实际登录、加载 OSM 地图、确认模块和配置 URL。
- 原有 de、are、cse、tutu、tv、wechat 六个站点均返回 200。
- 本机验收截图：`artifacts/deployed-panel.jpg`（已排除 Git）。
- 后续手机检查：iPhone 13 / iOS 18.7.8，定位模块、Token、VPN 配置模式、HTTPS / HTTP/2 MitM、CA 信任和微信定位权限均已核对。
- 重连 VPN、临时关闭定位服务约 10 秒后恢复，并重试朋友圈，仍未成功。同期未观察到模块的坐标拉取请求；未确定根本原因，也未据此认定为证书固定。
- 手机定位服务和原 VPN 连接已恢复，临时连接日志已关闭；没有发表或修改朋友圈内容。
- 随后按用户要求停止服务并关闭开机自启，入口保留暂停提示和证书续期验证路径。
