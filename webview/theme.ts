export interface Palette {
  background: string;
  foreground: string;
  entityFill: string;
  entityHeaderFill: string;
  border: string;
  containerBorder: string;
  containerFill: string;
  mutedText: string;
  relationshipLine: string;
  pkAccent: string;
  fkAccent: string;
  selectionBorder: string;
  /** Categorical palette for group containers -- one hue per group, cycled/hashed by name. */
  groupColors: string[];
}

const VAR_FALLBACKS: Record<string, string> = {
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-editorWidget-border': '#454545',
  '--vscode-focusBorder': '#007fd4',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-yellow': '#d7ba7d',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-textLink-foreground': '#3794ff',
};

/** VS Code's own categorical chart palette -- theme-adaptive, so it stays legible in any theme. */
const GROUP_COLOR_VARS = [
  '--vscode-charts-blue',
  '--vscode-charts-orange',
  '--vscode-charts-green',
  '--vscode-charts-purple',
  '--vscode-charts-red',
  '--vscode-charts-yellow',
];

function readVar(styles: CSSStyleDeclaration, name: string): string {
  const v = styles.getPropertyValue(name).trim();
  return v.length > 0 ? v : VAR_FALLBACKS[name] ?? '#888888';
}

export function resolvePalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: readVar(styles, '--vscode-editor-background'),
    foreground: readVar(styles, '--vscode-editor-foreground'),
    entityFill: readVar(styles, '--vscode-editorWidget-background'),
    entityHeaderFill: readVar(styles, '--vscode-list-hoverBackground'),
    border: readVar(styles, '--vscode-editorWidget-border'),
    containerBorder: readVar(styles, '--vscode-focusBorder'),
    containerFill: readVar(styles, '--vscode-editorWidget-background'),
    mutedText: readVar(styles, '--vscode-descriptionForeground'),
    relationshipLine: readVar(styles, '--vscode-charts-blue'),
    pkAccent: readVar(styles, '--vscode-charts-yellow'),
    fkAccent: readVar(styles, '--vscode-descriptionForeground'),
    selectionBorder: readVar(styles, '--vscode-focusBorder'),
    groupColors: GROUP_COLOR_VARS.map((name) => readVar(styles, name)),
  };
}
