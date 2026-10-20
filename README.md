# SiYuan Notebook Groups

[简体中文](./README.zh-CN.md)

**Group notebooks directly in SiYuan's existing document tree.** Organize independent notebooks into collapsible, folder-like groups without merging notebooks or moving their documents.

## Features

- **Notebook grouping in the original file tree:** see **Group → Notebook → Document** in the existing sidebar, rather than opening a separate dock.
- **Custom groups:** create, rename, collapse, expand, and remove groups.
- **Drag to organize:** move notebooks between groups using the drag handle next to each notebook; insert a notebook above or below another notebook to customize its order.
- **Persistent organization:** group membership, group expansion state, and notebook order are saved in plugin settings.
- **Unassigned notebooks:** notebooks not in any group appear in an *Ungrouped Notebooks* section.
- **Non-destructive:** groups are a visual organization layer; removing a group does not delete the notebooks or documents inside it.

## Usage

1. Enable **Notebook Groups (笔记本分组管理)** in SiYuan.
2. In the existing document tree, select **Manage Groups** to create a group.
3. Drag a notebook by its **⠿ handle** onto a group or between notebooks inside that group. A visual insertion indicator shows the target position.
4. Click a group title to collapse or expand it. Use **Manage Groups** to rename or delete groups, or set a notebook's group directly.

## Installation

After the plugin becomes available in the SiYuan marketplace, install it from the marketplace and enable it. Until then, for local testing, build the project and extract the files inside `package.zip` into:

```text
{SiYuan workspace}/data/plugins/siyuan-notebook-groups/
```

`plugin.json` and `index.js` must be directly inside that folder, not inside an additional `dist` directory. Restart SiYuan after replacing installed files.

## Development

Requirements: Node.js and pnpm.

```bash
pnpm install
pnpm run build
```

The build produces `package.zip`. Source code is primarily in `src/index.ts`; plugin metadata is in `plugin.json`.

Contributions are welcome! Please open an issue for bugs or suggestions, and submit changes via a pull request. When changing the file-tree interaction, test grouping, drag sorting, document expansion, disabling the plugin, and restarting SiYuan.

## Compatibility and limitations

This plugin modifies SiYuan's existing file-tree **DOM** rather than using an official notebook-grouping API. Future SiYuan updates may change that structure and require plugin updates. The current feature has been tested during development in the Windows desktop interface; compatibility with other operating systems, mobile interfaces, and future versions is not yet verified.

## License

MIT. This project was started from the [official SiYuan plugin sample](https://github.com/siyuan-note/plugin-sample). Please preserve the upstream license and copyright notices when redistributing derivative code.

## Repository

https://github.com/2032797085-blip/siyuan-notebook-groups
