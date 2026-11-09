using Microsoft.UI.Xaml;
using OpenFinalShell.App.Controls;
using System.Text;

namespace OpenFinalShell.App;

internal sealed class TerminalLayoutFixtureWindow : Window
{
    private const string LayoutFixture =
        "################################################\r\n" +
        "\u001b[1mWinUI3 terminal layout fixture | IP2Location Scamalytics AbuseIPDB\u001b[0m\r\n" +
        "IP类型:   \u001b[48;5;179m 机房 IP \u001b[0m  \u001b[48;5;203m 高风险 \u001b[0m\r\n" +
        "数据库:   IPinfo     ipregistry     ipapi\r\n" +
        "状态:     \u001b[42;30m 解锁 \u001b[0m \u001b[43;30m [JP] \u001b[0m \u001b[41;37m 未解锁 \u001b[0m\r\n" +
        "默认前景: \u001b[48;5;114m 机房 \u001b[0m \u001b[48;5;217m 高风险 \u001b[0m \u001b[48;5;180m 未知 \u001b[0m\r\n" +
        "风险等级: \u001b[42m 极低 \u001b[0m\u001b[42m 低 \u001b[0m\u001b[43m 中 \u001b[0m\u001b[41m 高 \u001b[0m\u001b[41m 极高 \u001b[0m\r\n" +
        "较低风险 | 较高风险 | 无风险 | 连续中文词组\r\n" +
        "连续背景: \u001b[48;5;24m                    \u001b[0m\r\n" +
        "块字符:   \u001b[32m████████\u001b[0m  \u001b[36m────────\u001b[0m\r\n" +
        "混合列:   A中B文C言D字E  节点   Tokyo   101-8656\r\n" +
        "英文列:   IP2Location Scamalytics AbuseIPDB Reddit ChatGPT\r\n" +
        "组合字符: A\u0301  e\u0308  中\r\n";

    private readonly NativeTerminalCanvas terminal = new() { Margin = new Thickness(8) };

    public TerminalLayoutFixtureWindow()
    {
        Title = "OpenFinalShell terminal layout fixture";
        Content = terminal;
        terminal.Loaded += (_, _) => terminal.Feed(Encoding.UTF8.GetBytes(LayoutFixture));
    }
}
