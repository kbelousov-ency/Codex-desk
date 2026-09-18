const pixels = ['01000010', '00100100', '01111110', '11011011', '11111111', '10100101', '00100100', '01000010'];

export default function PixelAvatar() {
  return <svg className="pixel-avatar" width="16" height="16" viewBox="0 0 8 8" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    {pixels.flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === '1' ? [<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />] : []))}
  </svg>;
}
