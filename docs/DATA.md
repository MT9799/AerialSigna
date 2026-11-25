# 数据来源与许可

## 路网

- **OpenStreetMap**（© OpenStreetMap contributors，ODbL 1.0）。
- 在线瓦片：OpenFreeMap 2025-01-22 planet 快照，`https://tiles.openfreemap.org/planet/20250122/{z}/{x}/{y}.pbf`，无密钥。
- 中国范围道路要素：`highway=motorway|trunk|primary|secondary|tertiary|minor|service`；`minor` 对应 OSM 的 residential/unclassified。
- 每个县级单元以政府驻地为中心，取 20 km × 20 km 范围；384 px 参考图，道路按等级加宽（高速 3 px、主干 2 px、次干 2 px、支路 1 px）。

## 行政区划

- **DataV GeoAtlas** `https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json`，用于省/市/县边界与政府驻地。
- 共 **2,896** 个县级单元：DataV 返回 2,874 个（含港澳），另按公开行政区划资料补齐台湾 22 个县市（`pipeline/add_taiwan.py`）。台湾部分因 OpenFreeMap 的 z11 无道路要素，构建时自动回退到 z12。

## 测试影像

- `samples/commons/`：Wikimedia Commons，逐张许可见 `samples/manifest.json`（CC BY / CC BY-SA / Public Domain）。
- `samples/commons/synthetic_beijing*.jpg`：由本项目从 OSM 参考图生成，仅用于算法回归，不是真实照片。

## 限制

- 路网只覆盖机动车道，不含步行街、小区内部路、临时道路。
- 20 km 参考图对特大城市中心可能偏小；后续按道路密度自适应选择 15–60 km 视场。
- 台湾/偏远地区 z11 数据稀疏，已用 z12 回退，但仍有少量瓦片请求失败。
