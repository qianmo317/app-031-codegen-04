// 柜体 → 稳定颜色（同柜同色，便于分拣）
const palette = [
  12, 45, 88, 152, 188, 214, 268, 300, 330, 0, 70, 130, 240, 290, 170
]

export function cabinetHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

export function cabinetFill(name: string): string {
  return `hsl(${cabinetHue(name)} 46% 88%)`
}

export function cabinetStroke(name: string): string {
  return `hsl(${cabinetHue(name)} 42% 52%)`
}

// 连纹组号 → 稳定配色（组号是三处出口共用的同一份编号）
export function groupHue(no: number): number {
  return palette[(no - 1) % palette.length]
}

export function groupHueColor(no: number): { stroke: string; fill: string; text: string } {
  const h = groupHue(no)
  return {
    stroke: `hsl(${h} 64% 42%)`,
    fill: `hsl(${h} 70% 94%)`,
    text: `hsl(${h} 70% 30%)`
  }
}
