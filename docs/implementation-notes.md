# 设计取舍与复验

## 活动与对话

参考了 [AIRI 的中文项目说明](https://github.com/moeru-ai/airi/blob/main/docs/README.zh-CN.md) 对本地虚拟角色的组织方式，以及 [ComPeer](https://arxiv.org/html/2407.18064v2) 对长期陪伴和主动交互的研究。这个原型把动作选择交给 Astra，把移动、接触、停留和成功判定留在本地。主动发言可以接上刚聊过的事，也可以省略；留出对话空档，用户没有回复时不连续开口。没有用另一页的草稿替当前聊天增加上下文。

模型返回的 JSON 是意图。例如 `move_cup` 只指向两个已知杯垫；反馈要等杯底稳定受托才更新。读书同样按实际可见帧记录已读页。下一件活动最多预想一步，条件改变就放弃；停下、离开或换动作后，旧模型回复不能再接管角色。

## 画面与接触

[Godot 的 SpringArm 说明](https://docs.godotengine.org/en/stable/tutorials/3d/spring_arm.html) 提供了避开相机与主体之间障碍的参考。这里保留用户转动镜头的目标，实际近景机位按角色位置避让，必要时留出安全距离。[Unity 的两骨 IK 说明](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.3/manual/constraints/TwoBoneIKConstraint.html) 可用来理解脚和手的目标、关节方向与权重。本项目按当前 Q 版模型单独校准；换模型后不会承诺道具触达通用。

“看向”也受姿态限制。站着时可以转身，坐着或在桌边时保留姿势，只对当前能朝向的目标执行；转身还在进行或被打断时不记录完成。这里判断的是朝向，不是眼动追踪。

挪杯时先看抓取处，再在横移前把视线转到实际落点。取舍参考了[手眼协调实验](https://pmc.ncbi.nlm.nih.gov/articles/PMC6763066/)中视线先到操作关键位置的观察；动画时长按当前模型选择。两版对照保持抓取、搬动和落杯轨迹一致。

书柜与大盆栽按材质批量绘制，参考 [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)。本机同一全景中，盆栽改动使渲染调用从 238 降到 220，三角形和纹理数不变；这是一次固定镜头的提交量对照，不能据此推断 GPU 帧耗时或功耗。用 `?inspect=1` 可查看自己环境的实际指标。

## 浏览器行为

[Chrome 的页面生命周期说明](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) 和 [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) 解释了为什么不能只靠标签页的可见标志。跨来源嵌入房间可能没有新画帧，却仍报告 `visible`。实现同时检查真实画帧；停顿不补跑动画，恢复后要先重新获得自主控制权。已观测到原生停帧取消真实模型请求，恢复后由新请求开启活动；短暂掉帧保留同页的安静停留，另用固定决策和真实浏览器复验。

同源自主控制权使用 [Web Locks](https://www.w3.org/TR/web-locks/)，短期交互协调使用 [BroadcastChannel](https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts)。后者只发送会过期的状态信号，不发聊天、草稿或记忆。两页同屏的对照用隔离后端固定延迟，避免把网络时延当作打断效果。

按 [Web Storage 标准](https://html.spec.whatwg.org/multipage/webstorage.html#introduction)，不能把共享存储的读后写当成有锁操作。会话偏好单独保存在当前标签页的 [sessionStorage](https://developer.mozilla.org/zh-CN/docs/Web/API/Window/sessionStorage)；另一页改长期称呼时，不会盖掉本页“这次别主动说话”。浏览器复制页面时可能会带一份初始值，后续各页独立。两页同时修改同一份长期记忆仍没有事务保证。

## 自己检查

- `npm test` 不调用 Astra。缺少本地鲸鱼模型时，专用的几何测试明示跳过；通用协议、计时、导航和公开示例仍可验证。
- `COMPANION_OFFLINE=1 npm run dev` 可验证场景、表情与手动动作。真实陪聊需要本机登录和账号模型权限。
- `?inspect=1` 的记录包含动作反馈、画帧、书页、镜头和调用计数。自动化测试、固定模型结果的浏览器对照、真实 Astra 交互是三种不同证据；仓库不会包含本机聊天或诊断记录。
