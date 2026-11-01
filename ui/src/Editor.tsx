import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { api, type ValidationError } from './api.ts';

type Props = {
  path: string;
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
  onValidation: (errors: ValidationError[]) => void;
};

// CodeMirror owns the text. The editor is created once per file (the parent
// keys it by path), so `content` is only the starting text.
export function Editor({ path, content, onChange, onSave, onValidation }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onSave, onValidation });
  callbacks.current = { onChange, onSave, onValidation };

  useEffect(() => {
    const view = new EditorView({
      parent: parent.current!,
      doc: content,
      extensions: [
        basicSetup,
        path.endsWith('.json') ? json() : yaml(),
        matchMedia('(prefers-color-scheme: dark)').matches ? oneDark : [],
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              callbacks.current.onSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.current.onChange(update.state.doc.toString());
          }
        }),
        lintGutter(),
        linter((view) => validate(view, path, callbacks.current.onValidation), {
          delay: 400,
        }),
      ],
    });

    return () => view.destroy();
  }, [path]);

  return <div className="editor" ref={parent} />;
}

// Asks the server, so the editor checks exactly what the runner would.
async function validate(
  view: EditorView,
  path: string,
  onValidation: (errors: ValidationError[]) => void,
): Promise<Diagnostic[]> {
  const doc = view.state.doc;
  const validation = await api.validate(path, doc.toString()).catch(() => undefined);

  // Results for text that has changed since would point at the wrong places.
  if (!validation || view.state.doc !== doc) {
    return [];
  }

  const errors = validation.valid ? [] : validation.errors;
  onValidation(errors);

  return errors
    .filter((error) => error.from !== undefined)
    .map((error) => ({
      from: Math.min(error.from!, doc.length),
      to: Math.min(error.to ?? error.from!, doc.length),
      severity: 'error',
      message: error.message,
    }));
}
