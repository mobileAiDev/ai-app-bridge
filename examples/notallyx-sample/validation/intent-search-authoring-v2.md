# v2：已授权的设备身份参数化

本修订依据父控制器转达的用户授权：后续允许使用 PGFM10 或 PKR110。仅将 v1 的物理设备身份校验改为显式输入；没有运行 Script 入口或操作手机，不能据此声称跨设备通过。

## 时间与材料

- 本次首个记录时钟：`2026-09-08T00:08:28.024Z`，此前已读取补充 HANDOFF。
- 源码修订与差异检查完成：`2026-09-08T00:09:23.636Z`。
- 交付完成：`2026-09-08T00:10:36.492Z`。本次没有记录到连接中断；v1 的历史中断仍属于原编写记录。

本次实际读取：

- 原交付 `intent-reuse-2026-09-07/independent-writer-v1/search-regression.js`。
- 新冻结补充包 `intent-reuse-2026-09-08/writer-device-supplement-v2/HANDOFF.md`、`status.json`、`inputs.json`、`manifest.json`。
- 本次写出的 v2 源码，用于语法与最终哈希检查。

以上路径均相对于 `/Users/macbook/Documents/CompanyProject/ai-app-bridge/build/ai_app_bridge_artifacts/`。原始查询、定位、等待与截图/树证据仍来自 `intent-reuse-2026-09-07/writer-bundle-v1` 的 PGFM10 / OPPO / `FYZLAU49X8OVQGJ7`；本次未重新读取该包或改写旧采证身份。未读取实现、父控制器、其他助手、memory 或包外历史；没有使用新探索、设备工具、skill 或子代理。

补充 `manifest.json` 的 SHA256 为 `40cbec63b282a5c19937e002325e3cf6b2108249293d74eb271262fb9aeaa9af`。其列出的 HANDOFF、inputs、status 共 3 个文件均已核对字节数和 SHA256。

## 新增输入契约与具体差异

`ctx.inputs.device` 必须显式提供非空字符串 `serial`、`manufacturer`、`model` 和正整数 `sdkInt`。补充包给出的本次值是：

```json
{
  "serial": "b46093e6",
  "manufacturer": "OnePlus",
  "model": "PKR110",
  "sdkInt": 36
}
```

源码只有以下 6 处定向替换，除此之外逐字节保留 v1：

1. 更新身份来源注释并删除固定 `SERIAL` 常量。
2. 在 `main` 中读取 `const device = inputs.device`。
3. 将 status 中 manufacturer/model/sdkInt/serial 的固定值比较改为与对应 device 字段严格相等比较。
4. 保持断言证据说明字段 `expectedSerial`，其值改为 `device.serial`。
5. 增加上述 device 输入的形状校验。
6. 将 device 形状校验并入原 `inputs.explicit-contract` 断言；没有新增或改名断言。

`ctx.call` 的命令和参数全部保持原样，目标仍由 Script spec 的 `target` 注入。没有自动选机、备用设备或 manufacturer 映射；`OnePlus` 不会转成 `OPPO`。App 包名、版本和 activity 校验保留。

业务查询与期望、选择器、可见范围计算、等待时限、滚动方式、证据文件、每页设备断言、跨页 code 断言、失败停止和取消控制点均保持 v1。`ctx.inputs.expected`、`out`、`cancelAfterTitle` 的原契约继续适用；新设备身份仅由新增 device 对象声明。

## 验证与交付边界

- `node --check search-regression.js` 通过；没有调用 `main`。
- 将全部 6 处修订反向还原后，与原 v1 源码完全相等；已确认 v1 文件未被修改。
- v1 源码 SHA256：`3f9864d958843f4f189f761535cfcf7f34f185ce6eaafb47fc52cc24f6e50877`。
- v2 源码 SHA256：`1ea38097ca7607ed1380103946978e79e225cd0a956e7b4edc4bf55fe4187f77`。

补充 status 只作为新设备身份的公开依据。该采样记录的 capturePersistence 仍处于 OPENING，不能当成新夹具完成或运行就绪的验收证据。APK、固定业务数据和运行前就绪由父控制器独立准备、核对。

v1 已披露的键盘响应字段未解释、raw tree/status 返回结构假设、滚动末端推断、截图与树非原子，以及数据库/偏好验收边界均保留。此次只证明参数化差异受限且语法有效；新设备上的正向、错误期望、取消及数据不变性试验均未由作者执行。应先独立复核并冻结 v2 源码，再重新执行全部试验，不累计不同版本的通过次数。
