# 礼品卡卡面由服务端下发

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

model-access-server 的礼品卡接口在原有 `faceCode` / `faces` 之外追加卡面对象 `GiftCardFaceStyle`：
`code`、各语言名称 `names`、不含金额的底图 `imageUrl`（1200×757）与金额印法
`amount { x, baseline, size, maxWidth, color }`（卡面坐标，字形固定 Anton）。出现在
`GET /api/gift-cards/purchase-policy` 的 `faceCatalog`（与 `faces` 同组同序）、
`POST /api/gift-cards/preview` 与 `/redeem` 的 `card.face`、`GET /api/gift-cards/purchased` 每张卡的
`face`；服务端不认识卡面代号时为 `null`。新卡面只在服务端登记，客户端不发版即可选、可画。

解析在 `@cindy/maker-shared/gift-card`（`projectGiftCardFaceStyle`、`projectGiftCardFaceCatalog`），
Desktop Main 投影与 Mobile 共用：代号须与卡的 `faceCode` 一致；底图只收 https（本机 localhost 可为
http），不收带账号密码的地址；印法须落在 1200×757 内，颜色为 `#RRGGBB`；名称 1–32 项、每项 1–40 字。
不合法时只丢弃这一项卡面信息，卡与列表照常读出，绝不因卡面整页按坏响应处理。

旧服务端不下发这些字段：新客户端只用内置的 cindy / cat / bell / leap，购买弹窗按服务端 `faces` 与
内置四张的交集列出，行为与此前相同。旧客户端忽略新增字段；它们的购买弹窗只列出自己认识的卡面，
收到新卡面的卡时显示默认卡面加金额。服务端约束：新卡面代号须匹配 `^[a-z][a-z0-9_-]{0,31}$`
（旧客户端按此校验 `faceCode`，不合规会让「我买的礼品卡」整页读取失败）；旧客户端仍多时，可选卡面
里至少保留一张内置卡面，否则旧客户端的购买弹窗没有可选卡面。服务端与客户端互不要求同步部署。
渲染与兜底见 `renderer/features/billing/GiftCardFace.tsx`、`apps/mobile/src/gift-card/GiftCardFace.tsx`，
回归见 `packages/maker-shared` 的 `giftCard.test.ts`、Desktop `projection.test.ts` 与
`GiftCardPurchaseDialog` / `GiftCardRedeemDialog` 测试。
