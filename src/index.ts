import {Plugin, Dialog, showMessage} from "siyuan";
import "./index.scss";

const STORAGE_KEY = "notebook-groups-data";
const OWNED = "data-notebook-groups-plugin";
const DROP_ATTR = "data-notebook-groups-drop";

type Group = {id: string; name: string; collapsed: boolean};
type SavedData = {groups: Group[]; assignments: Record<string, string>; order?: string[]};
type DropPosition = {groupId: string; beforeId?: string; afterId?: string; highlight: HTMLElement; edge?: "before" | "after"};
type Notebook = {id: string; name: string};

export default class NotebookGroupsPlugin extends Plugin {
    private groups: Group[] = [];
    private assignments: Record<string, string> = {};
    private order: string[] = [];
    private tree: HTMLElement | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastSignature = "";
    // 使用专用手柄处理拖动，避免与思源原生的笔记本排序拖拽冲突。
    private pointerDrag: {notebookId: string; x: number; y: number; moved: boolean} | null = null;
    private dragBadge: HTMLElement | null = null;
    private highlightedDrop: HTMLElement | null = null;
    private highlightedStyle = "";
    // 禁止思源原生的“移动到某个笔记本下方”拖拽，以免误导用户。
    // 只阻止根笔记本的拖拽，普通文档仍保留思源原生拖拽行为。
    private readonly preventNativeNotebookDrag = (event: DragEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest('li[data-type="navigation-root"]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };

    // 判断光标所在的分组与插入位置。笔记本里的文档不参与笔记本排序。
    private dropPositionAt(x: number, y: number): DropPosition | null {
        if (!this.tree) return null;
        const element = document.elementFromPoint(x, y);
        if (!(element instanceof Element)) return null;
        const target = element.closest<HTMLElement>(`[${DROP_ATTR}="true"]`);
        if (!target || !this.tree.contains(target)) return null;
        const groupId = target.dataset.groupId;
        if (groupId === undefined) return null;
        if (target.getAttribute(OWNED) !== "members") {
            return {groupId, highlight: target}; // 拖到分组名称：放到该分组末尾
        }
        const nodeLists = Array.from(target.children).filter(
            (child): child is HTMLUListElement => child instanceof HTMLUListElement && child.hasAttribute("data-url")
        );
        if (nodeLists.length === 0) return {groupId, highlight: target};

        // 先寻找真正位于鼠标下方的笔记本（即使鼠标碰到其中的文档，也不会改变文档层级）。
        let hitNotebook: HTMLUListElement | null = null;
        let ancestor: Element | null = element;
        while (ancestor && ancestor !== target) {
            if (ancestor.parentElement === target && ancestor instanceof HTMLUListElement && ancestor.dataset.url) {
                hitNotebook = ancestor;
                break;
            }
            ancestor = ancestor.parentElement;
        }
        if (hitNotebook) {
            const row = hitNotebook.querySelector<HTMLElement>('li[data-type="navigation-root"]') || hitNotebook;
            const bounds = row.getBoundingClientRect();
            const before = y < bounds.top + bounds.height / 2;
            return {
                groupId,
                ...(before ? {beforeId: hitNotebook.dataset.url} : {afterId: hitNotebook.dataset.url}),
                highlight: row,
                edge: before ? "before" : "after",
            };
        }
        // 鼠标落在笔记本之间的空隙，插入到下一个笔记本之前。
        for (const node of nodeLists) {
            const bounds = node.getBoundingClientRect();
            if (y < bounds.top) {
                return {groupId, beforeId: node.dataset.url, highlight: node.firstElementChild as HTMLElement || node, edge: "before"};
            }
        }
        return {groupId, highlight: target}; // 列表末尾
    }

    private clearDropHighlight() {
        if (this.highlightedDrop) this.highlightedDrop.style.boxShadow = this.highlightedStyle;
        this.highlightedDrop = null;
        this.highlightedStyle = "";
    }

    private readonly movePointerDrag = (event: PointerEvent) => {
        const drag = this.pointerDrag;
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 5) {
            drag.moved = true;
            const badge = document.createElement("div");
            badge.textContent = "拖至目标分组";
            badge.style.cssText = "position:fixed;z-index:99999;pointer-events:none;" +
                "padding:5px 9px;border-radius:5px;background:var(--b3-theme-primary);" +
                "color:var(--b3-theme-on-primary);box-shadow:0 2px 8px #0003;font-size:12px";
            document.body.appendChild(badge);
            this.dragBadge = badge;
        }
        if (!drag.moved) return;
        if (this.dragBadge) {
            this.dragBadge.style.left = `${event.clientX + 12}px`;
            this.dragBadge.style.top = `${event.clientY + 12}px`;
        }
        const position = this.dropPositionAt(event.clientX, event.clientY);
        const highlighted = position?.highlight || null;
        const effect = position?.edge === "before"
            ? "inset 0 3px 0 var(--b3-theme-primary)"
            : position?.edge === "after"
                ? "inset 0 -3px 0 var(--b3-theme-primary)"
                : "inset 0 0 0 2px var(--b3-theme-primary)";
        if (highlighted !== this.highlightedDrop || (highlighted && highlighted.style.boxShadow !== effect)) {
            this.clearDropHighlight();
            if (highlighted) {
                this.highlightedDrop = highlighted;
                this.highlightedStyle = highlighted.style.boxShadow;
                highlighted.style.boxShadow = effect;
            }
        }
        if (this.dragBadge) {
            this.dragBadge.textContent = position?.edge === "before" ? "插入到此笔记本上方"
                : position?.edge === "after" ? "插入到此笔记本下方"
                : position ? "移动到此分组末尾" : "拖至目标分组";
        }
    };

    private readonly endPointerDrag = (event: PointerEvent) => {
        const drag = this.pointerDrag;
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        const position = drag.moved ? this.dropPositionAt(event.clientX, event.clientY) : null;
        this.cleanupPointerDrag();
        if (!position) return;
        void this.commitMove(drag.notebookId, position);
    };

    private readonly cancelPointerDrag = () => this.cleanupPointerDrag();

    private cleanupPointerDrag() {
        document.removeEventListener("pointermove", this.movePointerDrag, true);
        document.removeEventListener("pointerup", this.endPointerDrag, true);
        document.removeEventListener("pointercancel", this.cancelPointerDrag, true);
        this.clearDropHighlight();
        this.dragBadge?.remove();
        this.dragBadge = null;
        this.pointerDrag = null;
    }

    private addDragHandles(nodes: HTMLUListElement[]) {
        for (const node of nodes) {
            const notebookId = node.dataset.url;
            const row = node.querySelector<HTMLElement>('li[data-type="navigation-root"]');
            if (!notebookId || !row || row.querySelector('[data-notebook-groups-grip]')) continue;
            const grip = document.createElement("span");
            grip.setAttribute("data-notebook-groups-grip", "true");
            grip.textContent = "⠿";
            grip.title = "按住这里拖动笔记本，可归组或调整位置";
            grip.setAttribute("aria-label", grip.title);
            grip.style.cssText = "cursor:grab;user-select:none;touch-action:none;" +
                "flex:none;width:16px;text-align:center;color:var(--b3-theme-on-surface);opacity:.8";
            grip.draggable = false;
            grip.addEventListener("pointerdown", (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                this.cleanupPointerDrag();
                this.pointerDrag = {notebookId, x: event.clientX, y: event.clientY, moved: false};
                document.addEventListener("pointermove", this.movePointerDrag, true);
                document.addEventListener("pointerup", this.endPointerDrag, true);
                document.addEventListener("pointercancel", this.cancelPointerDrag, true);
            }, true);
            const text = row.querySelector(".b3-list-item__text");
            if (text) row.insertBefore(grip, text);
            else row.appendChild(grip);
        }
    }

    private async commitMove(notebookId: string, position: DropPosition) {
        const previousAssignments = {...this.assignments};
        const previousOrder = [...this.order];
        const nodeIds = this.tree ? this.allNotebookElements(this.tree).map(node => node.dataset.url || "").filter(Boolean) : [];
        // 保留所有笔记本的已有顺序；新出现的笔记本自动追加。
        const updated = [...new Set([...this.order, ...nodeIds])].filter(id => id !== notebookId);
        let insertIndex = updated.length;
        if (position.beforeId && position.beforeId !== notebookId) {
            const index = updated.indexOf(position.beforeId);
            if (index >= 0) insertIndex = index;
        } else if (position.afterId && position.afterId !== notebookId) {
            const index = updated.indexOf(position.afterId);
            if (index >= 0) insertIndex = index + 1;
        } else {
            // 丢到分组标题或空白处时，追加到该分组最后一个成员之后。
            const members = updated.filter(id => (this.assignments[id] || "") === position.groupId);
            if (members.length) insertIndex = updated.indexOf(members[members.length - 1]) + 1;
        }
        updated.splice(insertIndex, 0, notebookId);
        this.order = updated;
        if (position.groupId) this.assignments[notebookId] = position.groupId;
        else delete this.assignments[notebookId];
        this.updateTree(true);
        try {
            await this.saveData(STORAGE_KEY, {
                groups: this.groups, assignments: this.assignments, order: this.order,
            });
            showMessage("笔记本位置已保存");
        } catch (error) {
            this.assignments = previousAssignments;
            this.order = previousOrder;
            this.updateTree(true);
            console.error("笔记本拖拽保存失败", error);
            showMessage("拖拽保存失败，已恢复原位置");
        }
    }

    async onload() {
        try {
            const saved = await this.loadData(STORAGE_KEY) as SavedData | undefined;
            if (saved && Array.isArray(saved.groups)) {
                this.groups = saved.groups.filter(group => group && typeof group.id === "string" && typeof group.name === "string")
                    .map(group => ({id: group.id, name: group.name, collapsed: Boolean(group.collapsed)}));
            }
            if (saved?.assignments && typeof saved.assignments === "object" && !Array.isArray(saved.assignments)) {
                this.assignments = {...saved.assignments};
            }
            if (saved?.order && Array.isArray(saved.order)) {
                this.order = saved.order.filter(id => typeof id === "string");
            }
        } catch (error) {
            console.warn("笔记本分组：尚无保存的配置，或读取失败", error);
        }
    }

    onLayoutReady() {
        this.updateTree(true);
        this.timer = setInterval(() => this.updateTree(false), 1200);
    }

    onunload() {
        if (this.timer) clearInterval(this.timer);
        this.cleanupPointerDrag();
        this.restoreTree();
    }

    private async save() {
        try {
            await this.saveData(STORAGE_KEY, {groups: this.groups, assignments: this.assignments, order: this.order});
        } catch (error) {
            console.error("笔记本分组保存失败", error);
            showMessage("保存分组失败，请查看开发者工具");
        }
    }

    private findTree(): HTMLElement | null {
        // 只处理原生“文档”面板，不处理插件自己的面板。
        return document.querySelector<HTMLElement>(
            '.file-tree.sy__file .file-tree__items, .sy__file .file-tree__items'
        );
    }

    private allNotebookElements(tree: HTMLElement): HTMLUListElement[] {
        const direct = Array.from(tree.children).filter(
            (el): el is HTMLUListElement => el.tagName === "UL" && el.hasAttribute("data-url")
        );
        const nested = Array.from(tree.querySelectorAll<HTMLUListElement>(
            `[${OWNED}="members"] > ul[data-url]`
        ));
        const unique = Array.from(new Set([...direct, ...nested]));
        return unique.sort((a, b) => {
            const ai = this.order.indexOf(a.dataset.url || "");
            const bi = this.order.indexOf(b.dataset.url || "");
            if (ai >= 0 && bi >= 0) return ai - bi;
            if (ai >= 0) return -1;
            if (bi >= 0) return 1;
            return Number(a.dataset.sort || 0) - Number(b.dataset.sort || 0);
        });
    }

    private notebookNames(nodes: HTMLUListElement[]): Notebook[] {
        return nodes.map(node => ({
            id: node.dataset.url || "",
            name: node.querySelector<HTMLElement>('li[data-type="navigation-root"] .b3-list-item__text')?.textContent?.trim()
                || node.querySelector<HTMLElement>(".b3-list-item__text")?.textContent?.trim()
                || node.dataset.url || "未知笔记本",
        })).filter(item => item.id !== "");
    }

    private signature(tree: HTMLElement, nodes: HTMLUListElement[]): string {
        const ids = nodes.map(node => node.dataset.url || "").join("|");
        const loose = Array.from(tree.children).some(el => el.tagName === "UL" && el.hasAttribute("data-url"));
        return `${ids}::${loose}::${JSON.stringify(this.groups)}::${JSON.stringify(this.assignments)}::${JSON.stringify(this.order)}`;
    }

    private updateTree(force: boolean) {
        const tree = this.findTree();
        if (!tree) return;
        if (this.tree && this.tree !== tree) this.restoreTree();
        if (this.tree !== tree) tree.addEventListener("dragstart", this.preventNativeNotebookDrag, true);
        this.tree = tree;
        const nodes = this.allNotebookElements(tree);
        if (nodes.length === 0 || this.pointerDrag) return;
        this.addDragHandles(nodes);
        // 升级旧版本配置时自动记录当前顺序，不改变已保存的分组关系。
        if (this.order.length === 0) this.order = nodes.map(node => node.dataset.url || "").filter(Boolean);
        const current = this.signature(tree, nodes);
        if (!force && current === this.lastSignature) return;
        this.lastSignature = current.replace("::true::", "::false::");

        // 先取出原生笔记本，避免删除旧分组容器时把原生节点一起删除。
        const holding = document.createDocumentFragment();
        for (const node of nodes) holding.appendChild(node);
        tree.querySelectorAll(`[${OWNED}="header"], [${OWNED}="group"], [${OWNED}="ungrouped"]`)
            .forEach(el => el.remove());

        const header = document.createElement("div");
        header.setAttribute(OWNED, "header");
        header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:5px 10px;gap:6px";
        const title = document.createElement("strong");
        title.textContent = "笔记本分组";
        const manage = this.button("管理分组", () => this.openManager());
        header.append(title, manage);
        tree.prepend(header);

        for (const group of this.groups) {
            const box = document.createElement("div");
            box.setAttribute(OWNED, "group");
            const heading = document.createElement("div");
            heading.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;user-select:none";
            const arrow = document.createElement("span");
            arrow.textContent = group.collapsed ? "▸" : "▾";
            arrow.style.width = "14px";
            const name = document.createElement("span");
            name.textContent = `📁 ${group.name}`;
            heading.append(arrow, name);
            heading.title = "点击展开或收起；也可将笔记本拖到此处归组";
            this.enableDrop(heading, group.id);
            heading.addEventListener("click", () => {
                group.collapsed = !group.collapsed;
                void this.save();
                this.updateTree(true);
            });
            const members = document.createElement("div");
            members.setAttribute(OWNED, "members");
            // 拖到组内笔记本上方/下方或空白处，归组同时记录笔记本顺序。
            this.enableDrop(members, group.id);
            members.style.cssText = `padding-left:14px;${group.collapsed ? "display:none;" : ""}`;
            for (const node of nodes) {
                if (this.assignments[node.dataset.url || ""] === group.id) members.appendChild(node);
            }
            box.append(heading, members);
            tree.appendChild(box);
        }

        const ungrouped = document.createElement("div");
        ungrouped.setAttribute(OWNED, "ungrouped");
        const ungroupedMembers = document.createElement("div");
        ungroupedMembers.setAttribute(OWNED, "members");
        // 允许拖到未分组笔记本列表内，直接取消分组。
        this.enableDrop(ungroupedMembers, "");
        ungroupedMembers.style.cssText = "";
        const knownGroupIds = new Set(this.groups.map(group => group.id));
        for (const node of nodes) {
            if (!knownGroupIds.has(this.assignments[node.dataset.url || ""])) {
                ungroupedMembers.appendChild(node);
            }
        }
        if (ungroupedMembers.childElementCount || this.groups.length > 0) {
            const heading = document.createElement("div");
            heading.textContent = "未分组笔记本";
            heading.style.cssText = "padding:7px 10px;font-size:12px;opacity:.7";
            heading.title = "将笔记本拖到这里可取消分组";
            this.enableDrop(heading, "");
            ungrouped.append(heading, ungroupedMembers);
        }
        tree.appendChild(ungrouped);
        this.lastSignature = this.signature(tree, nodes);
    }

    private restoreTree() {
        if (!this.tree) return;
        const tree = this.tree;
        const nodes = this.allNotebookElements(tree);
        tree.removeEventListener("dragstart", this.preventNativeNotebookDrag, true);
        for (const node of nodes) {
            node.querySelectorAll('[data-notebook-groups-grip]').forEach(grip => grip.remove());
            tree.appendChild(node);
        }
        tree.querySelectorAll(`[${OWNED}="header"], [${OWNED}="group"], [${OWNED}="ungrouped"]`)
            .forEach(el => el.remove());
        this.tree = null;
        this.lastSignature = "";
    }

    // 拖动手柄以 Pointer Events 归组；标题仅标记为投放目标。
    private enableDrop(target: HTMLElement, groupId: string) {
        target.setAttribute(DROP_ATTR, "true");
        target.dataset.groupId = groupId;
    }

    private button(label: string, click: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "b3-button b3-button--outline";
        button.textContent = label;
        button.style.cssText = "padding:3px 7px;min-height:25px";
        button.addEventListener("click", event => {
            event.stopPropagation();
            click();
        });
        return button;
    }

    private askName(title: string, initial: string, callback: (name: string) => void) {
        const dialog = new Dialog({
            title,
            width: "400px",
            content: '<div class="b3-dialog__content" style="padding:18px"><input class="b3-text-field fn__block" placeholder="分组名称"></div><div class="b3-dialog__action" style="padding:10px 18px"><button class="b3-button b3-button--cancel">取消</button><span class="fn__space"></span><button class="b3-button b3-button--text">确定</button></div>',
        });
        const input = dialog.element.querySelector("input") as HTMLInputElement;
        input.value = initial;
        input.focus();
        input.select();
        const submit = () => {
            const name = input.value.trim();
            if (!name) return showMessage("分组名称不能为空");
            callback(name);
            dialog.destroy();
        };
        const buttons = dialog.element.querySelectorAll("button");
        buttons[0].addEventListener("click", () => dialog.destroy());
        buttons[1].addEventListener("click", submit);
        input.addEventListener("keydown", event => { if (event.key === "Enter") submit(); });
    }

    private openManager() {
        const dialog = new Dialog({
            title: "管理笔记本分组",
            width: "520px",
            content: '<div class="b3-dialog__content" style="padding:16px;max-height:60vh;overflow:auto"></div>',
        });
        const content = dialog.element.querySelector(".b3-dialog__content") as HTMLElement;
        const redraw = () => {
            content.replaceChildren();
            content.appendChild(this.button("＋ 新建分组", () => this.askName("新建分组", "", name => {
                this.groups.push({id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, collapsed: false});
                void this.save();
                this.updateTree(true);
                redraw();
            })));
            for (const group of this.groups) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--b3-border-color)";
                const label = document.createElement("span");
                label.textContent = group.name;
                label.style.flex = "1";
                row.append(label, this.button("重命名", () => this.askName("重命名分组", group.name, name => {
                    group.name = name;
                    void this.save();
                    this.updateTree(true);
                    redraw();
                })), this.button("删除分组", () => {
                    if (!window.confirm(`删除分组“${group.name}”？不会删除笔记本或文档。`)) return;
                    this.groups = this.groups.filter(item => item.id !== group.id);
                    for (const id of Object.keys(this.assignments)) {
                        if (this.assignments[id] === group.id) delete this.assignments[id];
                    }
                    void this.save();
                    this.updateTree(true);
                    redraw();
                }));
                content.appendChild(row);
            }
            const subtitle = document.createElement("h4");
            subtitle.textContent = "设置每个笔记本所属分组";
            subtitle.style.margin = "14px 0 8px";
            content.appendChild(subtitle);
            const nodes = this.tree ? this.allNotebookElements(this.tree) : [];
            for (const book of this.notebookNames(nodes)) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:12px;padding:6px 0";
                const name = document.createElement("span");
                name.textContent = book.name;
                name.style.flex = "1";
                const select = document.createElement("select");
                select.className = "b3-select";
                const none = document.createElement("option");
                none.value = "";
                none.textContent = "未分组";
                select.appendChild(none);
                for (const group of this.groups) {
                    const option = document.createElement("option");
                    option.value = group.id;
                    option.textContent = group.name;
                    select.appendChild(option);
                }
                select.value = this.assignments[book.id] || "";
                select.addEventListener("change", () => {
                    if (select.value) this.assignments[book.id] = select.value;
                    else delete this.assignments[book.id];
                    void this.save();
                    this.updateTree(true);
                });
                row.append(name, select);
                content.appendChild(row);
            }
        };
        redraw();
    }
}
