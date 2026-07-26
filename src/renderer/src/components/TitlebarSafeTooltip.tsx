import { Tooltip } from 'antd'
import type { TooltipProps } from 'antd'

/**
 * 给"贴在标题栏正下方"的悬浮工具条用的 Tooltip：气泡一律朝下弹。
 *
 * 为什么需要它：窗口用 titleBarStyle:'hidden' + titleBarOverlay（见 main/window.ts），
 * 最小化/最大化/关闭三个按钮由 Windows 绘制、**永远盖在页面内容之上**，
 * 在 1280 视口下占据 x≈1143–1280、y 0–40 这块矩形。
 *
 * 而这块矩形对 CSS/JS 布局是不可见的：antd 的 autoAdjustOverflow 只跟视口比，
 * 它看到"上方还有地方"，就把 placement=top 的气泡放到 y≈14–40 —— 正好钻进系统按钮底下。
 * 用户看到的是「打开文件管理」只剩「打开」。这不是 antd 的 bug，antd 也不可能自己躲开。
 *
 * autoAdjustOverflow 必须显式关掉：不关的话，窗口很矮、或 SFTP 分屏把终端挤到只剩几十像素时，
 * antd 会"体贴地"把气泡翻回 top，bug 原地复活。关掉之后"朝下"才是硬保证 ——
 * 最坏也只是盖住下方的终端文字，而这只是个 hover 才出现的瞬时标签。
 *
 * 只有真正贴着窗口顶边的工具条需要它；左侧面板（x<270）与下半区的 SFTP 面板碰不到那块矩形。
 * 打包冒烟里有一步专门 hover 这些按钮、量气泡矩形与按钮区求交（packagedSmoke.mjs step 8.6）。
 */
export function TitlebarSafeTooltip(props: TooltipProps): React.JSX.Element {
  return <Tooltip placement="bottom" autoAdjustOverflow={false} {...props} />
}
