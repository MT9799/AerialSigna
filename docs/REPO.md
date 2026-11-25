# 发布说明

本仓库是纯静态站点，没有构建步骤：根目录的 `index.html` 直接由浏览器加载 `assets/js/*.js` 与 `data/fp/` 下的路网指纹。推送到 `main` 后，GitHub Actions 会通过 `actions/upload-pages-artifact` 发布整个仓库。

仓库地址（本地）：`D:\Documents\GitHub\AerialSigna`。

## 本地预览

```bash
cd AerialSigna
python -m http.server 8899
# 打开 http://127.0.0.1:8899/
```

## 更新全国索引

```bash
python pipeline/build_national.py --all --workers 16
python pipeline/add_center_desc.py
```

构建会读取 OpenFreeMap 的 2025-01-22 瓦片快照，按县裁剪 20 km 参考图，写入 `data/fp/cn/<省 adcode>/<县 adcode>_{r,d}.png` 与 50 维描述子。全国约 2,896 个县级单元，首次构建需要下载约 2.4 万个 z11 瓦片。
