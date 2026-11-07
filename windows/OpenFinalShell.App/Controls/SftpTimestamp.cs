using System.Globalization;

namespace OpenFinalShell.App.Controls;

internal static class SftpTimestamp
{
    public static string Format(DateTime value, string language)
    {
        var local = value.Kind == DateTimeKind.Utc ? value.ToLocalTime() : value;
        if (language.StartsWith("zh", StringComparison.OrdinalIgnoreCase))
        {
            const string weekdays = "日一二三四五六";
            return local.ToString("yyyy/M/d", CultureInfo.InvariantCulture) + "周" + weekdays[(int)local.DayOfWeek]
                + (local.Hour < 12 ? " 上午 " : " 下午 ") + local.ToString("hh:mm:ss", CultureInfo.InvariantCulture);
        }
        CultureInfo culture;
        try { culture = CultureInfo.GetCultureInfo(language); }
        catch (CultureNotFoundException) { culture = CultureInfo.InvariantCulture; }
        return local.ToString("G", culture);
    }
}
