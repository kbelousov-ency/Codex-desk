import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Deterministic branding drawn from the shipped icon and the renderer palette.
// Generated BMPs stay in the build directory; optional fonts come from the source tree.
export async function createInstallerBranding(root, directory, brandName = 'Кузьмич', iconPath = path.join(root, 'electron', 'icon.ico')) {
  await mkdir(directory, { recursive: true });
  // The shipped ICO stores a PNG (System.Drawing.Icon cannot draw this variant).
  const icon = await readFile(iconPath);
  const imageOffset = icon.readUInt32LE(18);
  const imageSize = icon.readUInt32LE(14);
  const image = icon.subarray(imageOffset, imageOffset + imageSize);
  if (icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) !== 1 || image.length !== imageSize || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Неизвестный формат значка Кузьмича.');
  const iconImage = path.join(directory, 'icon.png');
  await writeFile(iconImage, image);
  const script = path.join(directory, 'draw-branding.ps1');
  await writeFile(script, '\uFEFF' + String.raw`
param([string]$OutputDirectory, [string]$IconPath, [string]$BrandName = 'Кузьмич', [string]$TitleFontPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
function Brush([string]$hex) { [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($hex)) }
function Font([single]$size, [Drawing.FontStyle]$style = [Drawing.FontStyle]::Regular) { [Drawing.Font]::new('Segoe UI', $size, $style, [Drawing.GraphicsUnit]::Pixel) }
$deskKuzmich = $BrandName -ceq 'Кузьмич'
$deskPalette = if ($deskKuzmich) {
  @{ Accent = '#82968A'; Text = '#D5E0D8'; Muted = '#929D96'; Line = '#3A413D'; Sidebar = '#171A19'; Header = '#171A19' }
} else {
  @{ Accent = '#b6d8cc'; Text = '#e3e5e5'; Muted = '#91a49b'; Line = '#33443c'; Sidebar = '#141618'; Header = '#181a1c' }
}
$deskFontCollection = $null
if ($deskKuzmich -and (Test-Path -LiteralPath $TitleFontPath -PathType Leaf)) {
  try {
    $deskFontCollection = [Drawing.Text.PrivateFontCollection]::new()
    $deskFontCollection.AddFontFile($TitleFontPath)
    if ($deskFontCollection.Families.Count -eq 0) { throw 'Шрифт не загружен.' }
  } catch {
    if ($deskFontCollection) { $deskFontCollection.Dispose(); $deskFontCollection = $null }
  }
}
function BrandFont([single]$size) {
  if ($deskFontCollection) {
    try { return [Drawing.Font]::new($deskFontCollection.Families[0], $size, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel) } catch {}
  }
  return Font $size ([Drawing.FontStyle]::Bold)
}
$deskAccent = Brush $deskPalette.Accent
$deskText = Brush $deskPalette.Text
$deskMuted = Brush $deskPalette.Muted
$deskLine = Brush $deskPalette.Line
$deskIcon = [Drawing.Image]::FromFile($IconPath)
$deskTitleFont = BrandFont 19
$deskBodyFont = Font 12
$deskCaptionFont = Font 10
$deskHeaderFont = BrandFont 12
try {
  $deskSidebar = [Drawing.Bitmap]::new(164, 314, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $deskGraphics = [Drawing.Graphics]::FromImage($deskSidebar)
  try {
    $deskGraphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $deskGraphics.Clear([Drawing.ColorTranslator]::FromHtml($deskPalette.Sidebar))
    $deskGraphics.FillRectangle($deskAccent, 0, 0, 4, 314)
    $deskGraphics.DrawImage($deskIcon, [Drawing.Rectangle]::new(23, 31, 64, 64))
    $deskGraphics.DrawString($BrandName, $deskTitleFont, $deskText, [single]23, [single]111)
    $deskGraphics.DrawString("Ваши агенты.\nВаши проекты.".Replace('\n', [Environment]::NewLine), $deskBodyFont, $deskMuted, [single]24, [single]150)
    $deskGraphics.FillRectangle($deskLine, 24, 238, 116, 1)
    $deskGraphics.DrawString('Codex + Claude', $deskBodyFont, $deskAccent, [single]24, [single]251)
    $deskGraphics.DrawString('РАБОЧЕЕ ПРОСТРАНСТВО', $deskCaptionFont, $deskMuted, [single]24, [single]278)
    $deskSidebar.Save((Join-Path $OutputDirectory 'sidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $deskGraphics.Dispose(); $deskSidebar.Dispose() }
  $deskHeader = [Drawing.Bitmap]::new(150, 57, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $deskGraphics = [Drawing.Graphics]::FromImage($deskHeader)
  try {
    $deskGraphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $deskGraphics.Clear([Drawing.ColorTranslator]::FromHtml($deskPalette.Header))
    $deskHeaderText = if ($deskKuzmich) { $deskText } else { $deskAccent }
    $deskGraphics.DrawString($BrandName, $deskHeaderFont, $deskHeaderText, [single]3, [single]19)
    $deskGraphics.DrawImage($deskIcon, [Drawing.Rectangle]::new(103, 9, 38, 38))
    $deskHeader.Save((Join-Path $OutputDirectory 'header.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $deskGraphics.Dispose(); $deskHeader.Dispose() }
} finally {
  foreach ($deskResource in @($deskAccent, $deskText, $deskMuted, $deskLine, $deskIcon, $deskTitleFont, $deskBodyFont, $deskCaptionFont, $deskHeaderFont)) { $deskResource.Dispose() }
  if ($deskFontCollection) { $deskFontCollection.Dispose() }
}
`);
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-OutputDirectory', directory, '-IconPath', iconImage, '-BrandName', brandName,
      '-TitleFontPath', path.join(root, 'src', 'assets', 'fonts', 'RussoOne-Regular.ttf')],
    { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Не удалось подготовить оформление установщика (${code}).`)));
  });
  return { installerHeader: path.join(directory, 'header.bmp'), installerSidebar: path.join(directory, 'sidebar.bmp'), uninstallerSidebar: path.join(directory, 'sidebar.bmp') };
}
