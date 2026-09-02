package io.github.openfinalshell.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * OpenFinalShell's semantic color palette. Keep the palette neutral so the blue
 * accent is reserved for focus and primary actions instead of tinting every
 * surface on the screen.
 */
object OpenFinalShellColors {
    val BrandBlue = Color(0xFF1677FF)
    val BrandBlueLight = Color(0xFF005FCC)
    val BrandBlueDark = Color(0xFF8DB8FF)

    val LightBackground = Color(0xFFF8F9FC)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSurfaceVariant = Color(0xFFE9ECF2)
    val LightOutline = Color(0xFF74777F)
    val LightText = Color(0xFF1A1B1F)
    val LightTextMuted = Color(0xFF45474E)

    val DarkBackground = Color(0xFF111318)
    val DarkSurface = Color(0xFF191B20)
    val DarkSurfaceVariant = Color(0xFF292C33)
    val DarkOutline = Color(0xFF8E9099)
    val DarkText = Color(0xFFE3E2E9)
    val DarkTextMuted = Color(0xFFC4C6D0)

    val Success = Color(0xFF2E7D32)
    val SuccessContainer = Color(0xFFD3F0D1)
    val Warning = Color(0xFF9A6700)
    val WarningContainer = Color(0xFFFFE8B0)
    val Error = Color(0xFFBA1A1A)
    val ErrorContainer = Color(0xFFFFDAD6)

    val TerminalBackground = Color(0xFF0B0D10)
    val TerminalForeground = Color(0xFFDDE7D8)
    val TerminalCursor = Color(0xFF8AB4F8)
    val TerminalSelection = Color(0x665A7FB8)
}

/** Shared spacing and control dimensions. Use these values instead of ad-hoc dp values in new screens. */
object OpenFinalShellSpacing {
    val None: Dp = 0.dp
    val XSmall: Dp = 4.dp
    val Small: Dp = 8.dp
    val Medium: Dp = 12.dp
    val Large: Dp = 16.dp
    val XLarge: Dp = 24.dp
    val XXLarge: Dp = 32.dp

    val PageHorizontal: Dp = 16.dp
    val PageVertical: Dp = 16.dp
    val Section: Dp = 24.dp
    val ListItem: Dp = 12.dp
    val ControlHeight: Dp = 48.dp
    val CompactControlHeight: Dp = 40.dp
    val MinimumTouchTarget: Dp = 48.dp
    val TerminalToolbarHeight: Dp = 48.dp
}

/** Alias retained for callers that prefer a dimensions naming convention. */
object OpenFinalShellDimens {
    val pageHorizontal = OpenFinalShellSpacing.PageHorizontal
    val pageVertical = OpenFinalShellSpacing.PageVertical
    val section = OpenFinalShellSpacing.Section
    val listItem = OpenFinalShellSpacing.ListItem
    val controlHeight = OpenFinalShellSpacing.ControlHeight
    val compactControlHeight = OpenFinalShellSpacing.CompactControlHeight
    val minimumTouchTarget = OpenFinalShellSpacing.MinimumTouchTarget
}

val OpenFinalShellShapes = Shapes(
    small = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(10.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)
)

/** Typography uses platform sans-serif for UI and a separate monospace style for terminal content. */
val OpenFinalShellTypography = Typography(
    displayLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 57.sp, lineHeight = 64.sp),
    displayMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 45.sp, lineHeight = 52.sp),
    displaySmall = TextStyle(fontWeight = FontWeight.Normal, fontSize = 36.sp, lineHeight = 44.sp),
    headlineLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 32.sp, lineHeight = 40.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 36.sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 24.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 11.sp, lineHeight = 16.sp)
)

val OpenFinalShellTerminalTypography = Typography().copy(
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 18.sp
    )
)

private fun lightColors() = lightColorScheme(
    primary = OpenFinalShellColors.BrandBlueLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD9E8FF),
    onPrimaryContainer = Color(0xFF001B3E),
    secondary = Color(0xFF4D6078),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD5E4FD),
    onSecondaryContainer = Color(0xFF081C31),
    tertiary = Color(0xFF665E7A),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFECE1FF),
    onTertiaryContainer = Color(0xFF211637),
    background = OpenFinalShellColors.LightBackground,
    onBackground = OpenFinalShellColors.LightText,
    surface = OpenFinalShellColors.LightSurface,
    onSurface = OpenFinalShellColors.LightText,
    surfaceVariant = OpenFinalShellColors.LightSurfaceVariant,
    onSurfaceVariant = OpenFinalShellColors.LightTextMuted,
    outline = OpenFinalShellColors.LightOutline,
    error = OpenFinalShellColors.Error,
    onError = Color.White,
    errorContainer = OpenFinalShellColors.ErrorContainer,
    onErrorContainer = Color(0xFF410002)
)

private fun darkColors() = darkColorScheme(
    primary = OpenFinalShellColors.BrandBlueDark,
    onPrimary = Color(0xFF002F68),
    primaryContainer = Color(0xFF004694),
    onPrimaryContainer = Color(0xFFD9E8FF),
    secondary = Color(0xFFB9C8E2),
    onSecondary = Color(0xFF223247),
    secondaryContainer = Color(0xFF394960),
    onSecondaryContainer = Color(0xFFD5E4FD),
    tertiary = Color(0xFFD0C3E8),
    onTertiary = Color(0xFF362D49),
    tertiaryContainer = Color(0xFF4D4460),
    onTertiaryContainer = Color(0xFFECE1FF),
    background = OpenFinalShellColors.DarkBackground,
    onBackground = OpenFinalShellColors.DarkText,
    surface = OpenFinalShellColors.DarkSurface,
    onSurface = OpenFinalShellColors.DarkText,
    surfaceVariant = OpenFinalShellColors.DarkSurfaceVariant,
    onSurfaceVariant = OpenFinalShellColors.DarkTextMuted,
    outline = OpenFinalShellColors.DarkOutline,
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6)
)

private fun ColorScheme.withAccent(accent: Color): ColorScheme {
    val onAccent = if (accent.luminance() > 0.5f) Color(0xFF101114) else Color.White
    return copy(
        primary = accent,
        onPrimary = onAccent,
        primaryContainer = accent.copy(alpha = 0.20f),
        onPrimaryContainer = accent
    )
}
/**
 * Shared Material 3 theme for Android screens. Existing screens can adopt this
 * wrapper incrementally without changing their ViewModel or navigation code.
 */
@Composable
fun OpenFinalShellTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    accentColor: Color? = null,
    content: @Composable () -> Unit
) {
    val context = LocalContext.current
    val baseScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && darkTheme -> dynamicDarkColorScheme(context)
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> dynamicLightColorScheme(context)
        darkTheme -> darkColors()
        else -> lightColors()
    }
    val scheme = accentColor?.let(baseScheme::withAccent) ?: baseScheme

    MaterialTheme(
        colorScheme = scheme,
        typography = OpenFinalShellTypography,
        shapes = OpenFinalShellShapes,
        content = content
    )
}
