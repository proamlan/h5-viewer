import * as vscode from 'vscode';
import { Hdf5EditorProvider } from './hdf5EditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new Hdf5EditorProvider(context);
  const registration = vscode.window.registerCustomEditorProvider(
    Hdf5EditorProvider.viewType,
    provider,
    {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }
  );
  context.subscriptions.push(registration);

  context.subscriptions.push(
    vscode.commands.registerCommand('h5Viewer.reopenAsHdf5', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Open an .h5/.hdf5/.he5 file first.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        editor.document.uri,
        Hdf5EditorProvider.viewType
      );
    })
  );
}

export function deactivate(): void {
  // No-op: all disposables are managed via ExtensionContext subscriptions.
}
