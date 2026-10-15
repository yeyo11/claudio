import { Menu, shell, type MenuItemConstructorOptions } from 'electron';

export interface MenuFolders {
  data: string;
  workspace: string;
  logs: string;
}

export interface MenuActions {
  quit: () => void;
  checkForUpdates: () => void;
}

export function buildMenu(folders: MenuFolders, isDev: boolean, actions: MenuActions): Menu {
  const open = (path: string) => () => void shell.openPath(path);
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: open(folders.data) },
        { label: 'Open workspace folder', click: open(folders.workspace) },
        { label: 'Open logs folder', click: open(folders.logs) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', click: actions.quit },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Not the roles' Ctrl+R and Ctrl+Shift+R: they are the shell's (reverse search), and a
        // focused terminal must receive them
        { role: 'reload', accelerator: 'F5' },
        { role: 'forceReload', accelerator: 'Shift+F5' },
        ...(isDev ? [{ role: 'toggleDevTools', accelerator: 'F12' } as const] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // windowMenu's Close is Ctrl+W, which is the shell's (delete word); Alt+F4 still closes the window
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close', accelerator: 'Alt+F4' }],
    },
    {
      label: 'Help',
      submenu: [{ label: 'Check for updates…', click: actions.checkForUpdates }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
