import * as vscode from 'vscode';

/**
 * Open generated SQL in a new editor tab.
 *
 * Most commands only write to the clipboard, which is destructive — one
 * unrelated copy and the generated script is gone.
 */
export async function openSqlInEditor(sql: string): Promise<void> {
    if (!sql) {
        return;
    }
    const document = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
    await vscode.window.showTextDocument(document, { preview: false });
}
