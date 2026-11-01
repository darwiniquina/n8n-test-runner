import { useState } from 'react';
import type { TreeNode } from './api.ts';

type Props = {
  nodes: TreeNode[];
  selected?: string;
  onSelect: (path: string) => void;
};

export function FileTree({ nodes, selected, onSelect }: Props) {
  return (
    <ul className="tree">
      {nodes.map((node) =>
        node.type === 'folder' ? (
          <Folder key={node.path} node={node} selected={selected} onSelect={onSelect} />
        ) : (
          <li key={node.path}>
            <button
              className={node.path === selected ? 'tree-file selected' : 'tree-file'}
              onClick={() => onSelect(node.path)}
            >
              {node.name}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function Folder({ node, selected, onSelect }: { node: TreeNode } & Omit<Props, 'nodes'>) {
  const [open, setOpen] = useState(true);

  return (
    <li>
      <button className="tree-folder" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {node.name}
      </button>
      {open && <FileTree nodes={node.children ?? []} selected={selected} onSelect={onSelect} />}
    </li>
  );
}
