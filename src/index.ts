import {Plugin, Dialog, fetchPost, getFrontend, showMessage, confirm as siyuanConfirm} from "siyuan";
import "./index.scss";

const STORAGE_KEY = "notebook-groups-data";
const OWNED = "data-notebook-groups-plugin";
const DROP_ATTR = "data-notebook-groups-drop";

type Group = {id: string; name: string; collapsed: boolean};
type SavedData = {groups: Group[]; assignments: Record<string, string>; order?: string[]; ungroupedCollapsed?: boolean};
type DropPosition = {groupId: string; beforeId?: string; afterId?: string; highlight: HTMLElement; edge?: "before" | "after"};
type Notebook = {id: string; name: string; closed?: boolean};
type SiYuanResponse<T> = {code: number; msg?: string; data?: T};

export default class NotebookGroupsPlugin extends Plugin {
    private groups: Group[] = [];
    private assignments: Record<string, string> = {};
    private order: string[] = [];
    private ungroupedCollapsed = false;
    private tree: HTMLElement | null = null;
    private readonly isMobile = ["mobile", "browser-mobile"].indexOf(getFrontend()) !== -1;
    // 移动端仅为原生笔记本 UL 附加样式和按钮，不搬动笔记本及文档节点。
    // 思源 MobileFiles 会直接遍历根节点的子 UL，改变其真实父子关系会破坏原生操作。
    private mobileNativeTree: HTMLElement | null = null;
    private mobileNativeBar: HTMLElement | null = null;
    private mobileNativeFooter: HTMLElement | null = null;
    private mobileNativeStyles = new Map<HTMLElement, {display: string; flexDirection: string; order: string; height: string; flexWrap: string}>();
    private mobileNotebooks: Notebook[] = [];
    private mobileRefreshVersion = 0;
    private mobileDrag: {
        kind: "group" | "notebook"; id: string; pointerId: number; x: number; y: number;
        active: boolean; holdTimer: ReturnType<typeof setTimeout> | null;
    } | null = null;
    private mobileBadge: HTMLElement | null = null;
    private mobileDropHighlight: HTMLElement | null = null;
    private mobileDropShadow = "";
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastSignature = "";
    // PC 上使用 HTML5 原生拖放：拖动整行，保留普通点击及原生文档拖放。
    private desktopDrag: {kind: "group" | "notebook"; id: string} | null = null;
    private desktopPressAllowed = true;
    private desktopRowDraggable = new Map<HTMLElement, string | null>();
    private dragBadge: HTMLElement | null = null;
    private highlightedDrop: HTMLElement | null = null;
    private highlightedStyle = "";
    private mobileRowBindings = new Map<HTMLElement, {
        pointer: (event: PointerEvent) => void; touch: (event: TouchEvent) => void;
    }>();
    private mobileTouchId: number | null = null;
    // 思源原生文档拖动期间，插件绝不能接管触摸或刷新文档树。
    // 触摸结束后留出短暂缓冲，让思源完成放置提示的清理。
    private nativeDocumentGesture = false;
    private nativeDocumentDragUntil = 0;
    private readonly isNativeDocumentEvent = (target: EventTarget | null): boolean => {
        if (!(target instanceof Element) || !this.mobileNativeTree?.contains(target)) return false;
        const row = target.closest("li");
        return Boolean(row && this.mobileNativeTree.contains(row) && row.getAttribute("data-type") !== "navigation-root");
    };
    private readonly onNativeDocumentTouchStart = (event: TouchEvent) => {
        if (!this.isNativeDocumentEvent(event.target)) return;
        this.nativeDocumentGesture = true;
        this.cleanupMobileDrag();
    };
    private readonly onNativeDocumentTouchEnd = (event: TouchEvent) => {
        if (!this.nativeDocumentGesture || event.touches.length) return;
        this.nativeDocumentGesture = false;
        this.nativeDocumentDragUntil = Date.now() + 1000;
    };
    private readonly onNativeDocumentDragStart = (event: DragEvent) => {
        if (!this.isNativeDocumentEvent(event.target)) return;
        this.nativeDocumentGesture = true;
        this.cleanupMobileDrag();
    };
    private readonly onNativeDocumentDragEnd = () => {
        if (!this.nativeDocumentGesture) return;
        this.nativeDocumentGesture = false;
        this.nativeDocumentDragUntil = Date.now() + 1000;
    };
    private suppressMobileClickUntil = 0;
    private readonly stopMobileClickAfterDrag = (event: MouseEvent) => {
        if (Date.now() > this.suppressMobileClickUntil) return;
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('.notebook-groups-native-heading, li[data-type="navigation-root"]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressMobileClickUntil = 0;
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

    // 与笔记本拖动分离：只重新排列 groups，不修改各组内的笔记本顺序。
    private groupDropPositionAt(x: number, y: number): {id: string; after: boolean; highlight: HTMLElement} | null {
        if (!this.tree) return null;
        const element = document.elementFromPoint(x, y);
        if (!(element instanceof Element)) return null;
        const box = element.closest<HTMLElement>(`[${OWNED}="group"]`);
        if (!box || !this.tree.contains(box)) return null;
        const groupId = box.dataset.groupId;
        const heading = box.firstElementChild as HTMLElement | null;
        if (!groupId || !heading) return null;
        const rect = heading.getBoundingClientRect();
        return {id: groupId, after: y >= rect.top + rect.height / 2, highlight: heading};
    }

    // 只处理根笔记本或插件自身分组的拖放，普通文档继续交给思源处理。
    private readonly desktopPointerDown = (event: PointerEvent) => {
        const target = event.target;
        this.desktopPressAllowed = target instanceof Element &&
            !Boolean(target.closest('button, input, select, textarea, [contenteditable="true"], .b3-list-item__action, .b3-list-item__toggle'));
    };

    private readonly desktopDragStart = (event: DragEvent) => {
        const target = event.target;
        if (!(target instanceof Element) || !this.tree) return;
        const groupHeading = target.closest<HTMLElement>('[data-notebook-groups-heading="true"]');
        const rootRow = target.closest<HTMLElement>('li[data-type="navigation-root"]');
        const groupId = groupHeading?.dataset.groupId;
        const notebookId = rootRow?.closest<HTMLUListElement>('ul[data-url]')?.dataset.url;
        if (!groupHeading && !rootRow) return;
        // 不在按钮或原生菜单上发起拖动。
        if (!this.desktopPressAllowed || (groupHeading && !groupId) || (!groupHeading && !notebookId)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        this.desktopDrag = groupHeading
            ? {kind: "group", id: groupId!}
            : {kind: "notebook", id: notebookId!};
        event.stopImmediatePropagation();
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", `siyuan-notebook-groups:${this.desktopDrag.kind}:${this.desktopDrag.id}`);
        }
    };

    private readonly desktopDragOver = (event: DragEvent) => {
        if (!this.desktopDrag) return;
        const position = this.desktopDrag.kind === "group"
            ? this.groupDropPositionAt(event.clientX, event.clientY)
            : this.dropPositionAt(event.clientX, event.clientY);
        if (!position) { this.clearDropHighlight(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const highlight = position.highlight;
        const edge = "after" in position ? (position.after ? "after" : "before") : position.edge;
        const effect = edge === "before" ? "inset 0 3px 0 var(--b3-theme-primary)"
            : edge === "after" ? "inset 0 -3px 0 var(--b3-theme-primary)"
                : "inset 0 0 0 2px var(--b3-theme-primary)";
        if (highlight !== this.highlightedDrop || highlight.style.boxShadow !== effect) {
            this.clearDropHighlight();
            this.highlightedDrop = highlight;
            this.highlightedStyle = highlight.style.boxShadow;
            highlight.style.boxShadow = effect;
        }
    };

    private readonly desktopDrop = (event: DragEvent) => {
        const drag = this.desktopDrag;
        if (!drag) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const position = drag.kind === "group"
            ? this.groupDropPositionAt(event.clientX, event.clientY)
            : this.dropPositionAt(event.clientX, event.clientY);
        this.cleanupDesktopDrag();
        if (!position) return;
        if (drag.kind === "group" && "after" in position && position.id !== drag.id) {
            void this.moveGroupTo(drag.id, position.id, position.after);
        } else if (drag.kind === "notebook" && "groupId" in position &&
            position.beforeId !== drag.id && position.afterId !== drag.id) {
            void this.commitMove(drag.id, position);
        }
    };

    private readonly desktopDragEnd = () => this.cleanupDesktopDrag();
    private cleanupDesktopDrag() {
        this.desktopDrag = null;
        this.clearDropHighlight();
        this.dragBadge?.remove();
        this.dragBadge = null;
    }

    private async moveGroupTo(groupId: string, targetId: string, after: boolean) {
        const previous = [...this.groups];
        const source = this.groups.find(group => group.id === groupId);
        if (!source || !this.groups.some(group => group.id === targetId)) return;
        const next = this.groups.filter(group => group.id !== groupId);
        const index = next.findIndex(group => group.id === targetId);
        next.splice(index + (after ? 1 : 0), 0, source);
        this.groups = next;
        this.updateTree(true);
        try {
            await this.saveData(STORAGE_KEY, {groups: this.groups, assignments: this.assignments, order: this.order, ungroupedCollapsed: this.ungroupedCollapsed});
        } catch (error) {
            this.groups = previous;
            this.updateTree(true);
            console.error("分组排序保存失败", error);
            showMessage("分组排序保存失败，已恢复原顺序");
        }
    }

    private prepareNativeDesktopRows(nodes: HTMLUListElement[]) {
        for (const node of nodes) {
            const row = node.querySelector<HTMLElement>('li[data-type="navigation-root"]');
            if (!row || this.desktopRowDraggable.has(row)) continue;
            this.desktopRowDraggable.set(row, row.getAttribute("draggable"));
            row.draggable = true;
            row.classList.add("notebook-groups-row-draggable");
        }
    }

    private async commitMove(notebookId: string, position: DropPosition) {
        const previousAssignments = {...this.assignments};
        const previousOrder = [...this.order];
        const nodeIds = this.tree ? this.allNotebookElements(this.tree).map(node => node.dataset.url || "").filter(Boolean) : [];
        // 保留所有笔记本的已有顺序；新出现的笔记本自动追加。
        const updated = [...new Set([...this.order, ...nodeIds, ...(this.isMobile ? this.mobileNotebooks.map(book => book.id) : [])])].filter(id => id !== notebookId);
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
                groups: this.groups, assignments: this.assignments, order: this.order, ungroupedCollapsed: this.ungroupedCollapsed,
            });
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
            // 手机端“未分组笔记本”始终展开，忽略旧版保存的折叠状态。
            this.ungroupedCollapsed = false;
        } catch (error) {
            console.warn("笔记本分组：尚无保存的配置，或读取失败", error);
        }
    }

    onLayoutReady() {
        if (this.isMobile) {
            document.addEventListener("click", this.stopMobileClickAfterDrag, true);
            document.addEventListener("touchstart", this.onNativeDocumentTouchStart, true);
            document.addEventListener("touchend", this.onNativeDocumentTouchEnd, true);
            document.addEventListener("touchcancel", this.onNativeDocumentTouchEnd, true);
            document.addEventListener("dragstart", this.onNativeDocumentDragStart, true);
            document.addEventListener("dragend", this.onNativeDocumentDragEnd, true);
            document.addEventListener("drop", this.onNativeDocumentDragEnd, true);
            this.updateMobileTree(true);
            void this.refreshMobileNotebooks();
            this.timer = setInterval(() => this.updateMobileTree(false), 1200);
        } else {
            this.updateTree(true);
            this.timer = setInterval(() => this.updateTree(false), 1200);
        }
    }

    onunload() {
        if (this.timer) clearInterval(this.timer);
        this.cleanupDesktopDrag();
        this.cleanupMobileDrag();
        this.mobileRefreshVersion++;
        document.removeEventListener("click", this.stopMobileClickAfterDrag, true);
        document.removeEventListener("touchstart", this.onNativeDocumentTouchStart, true);
        document.removeEventListener("touchend", this.onNativeDocumentTouchEnd, true);
        document.removeEventListener("touchcancel", this.onNativeDocumentTouchEnd, true);
        document.removeEventListener("dragstart", this.onNativeDocumentDragStart, true);
        document.removeEventListener("dragend", this.onNativeDocumentDragEnd, true);
        document.removeEventListener("drop", this.onNativeDocumentDragEnd, true);
        this.nativeDocumentGesture = false;
        this.nativeDocumentDragUntil = 0;
        this.restoreMobileTree();
        this.restoreTree();
    }

    private async save() {
        try {
            await this.saveData(STORAGE_KEY, {groups: this.groups, assignments: this.assignments, order: this.order, ungroupedCollapsed: this.ungroupedCollapsed});
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
        if (this.isMobile) { this.updateMobileTree(force); return; }
        const tree = this.findTree();
        if (!tree) return;
        if (this.tree && this.tree !== tree) this.restoreTree();
        if (this.tree !== tree) {
            tree.addEventListener("pointerdown", this.desktopPointerDown, true);
            tree.addEventListener("dragstart", this.desktopDragStart, true);
            tree.addEventListener("dragover", this.desktopDragOver, true);
            tree.addEventListener("drop", this.desktopDrop, true);
            tree.addEventListener("dragend", this.desktopDragEnd, true);
        }
        this.tree = tree;
        const nodes = this.allNotebookElements(tree);
        if (this.desktopDrag) return;
        this.prepareNativeDesktopRows(nodes);
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
            box.dataset.groupId = group.id;
            const heading = document.createElement("div");
            heading.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;user-select:none";
            const arrow = document.createElement("span");
            arrow.textContent = group.collapsed ? "▸" : "▾";
            arrow.style.width = "14px";
            const name = document.createElement("span");
            name.textContent = `📁 ${group.name}`;
            heading.dataset.notebookGroupsHeading = "true";
            heading.dataset.groupId = group.id;
            heading.draggable = true;
            heading.classList.add("notebook-groups-heading-draggable");
            const plus = document.createElement("button");
            plus.className = "notebook-groups-plus b3-tooltips b3-tooltips__w";
            plus.type = "button";
            plus.textContent = "+";
            plus.title = "在此分组中新建笔记本";
            plus.setAttribute("aria-label", plus.title);
            plus.addEventListener("click", event => {
                event.stopPropagation();
                this.askName("新建笔记本", "", notebookName => void this.createNotebook(group.id, notebookName));
            });
            name.style.flex = "1";
            heading.append(arrow, name, plus);
            heading.title = "点击展开/收起；按住整行可拖动分组";
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
        tree.removeEventListener("pointerdown", this.desktopPointerDown, true);
        tree.removeEventListener("dragstart", this.desktopDragStart, true);
        tree.removeEventListener("dragover", this.desktopDragOver, true);
        tree.removeEventListener("drop", this.desktopDrop, true);
        tree.removeEventListener("dragend", this.desktopDragEnd, true);
        for (const [row, value] of this.desktopRowDraggable) {
            if (value === null) row.removeAttribute("draggable");
            else row.setAttribute("draggable", value);
            row.classList.remove("notebook-groups-row-draggable");
        }
        this.desktopRowDraggable.clear();
        for (const node of nodes) tree.appendChild(node);
        tree.querySelectorAll(`[${OWNED}="header"], [${OWNED}="group"], [${OWNED}="ungrouped"]`)
            .forEach(el => el.remove());
        this.tree = null;
        this.lastSignature = "";
    }

    // 标记可接受整行拖放的区域；原生文档节点不参与笔记本排序。
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
            width: this.isMobile && window.innerWidth < 450 ? "calc(100vw - 20px)" : "400px",
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


    private post<T>(url: string, body: Record<string, unknown>): Promise<SiYuanResponse<T>> {
        return new Promise((resolve, reject) => {
            try { fetchPost(url, body, (response: SiYuanResponse<T>) => resolve(response)); }
            catch (error) { reject(error); }
        });
    }

    private async createNotebook(groupId: string, name: string) {
        try {
            const response = await this.post<{notebook: Notebook}>("/api/notebook/createNotebook", {name});
            const notebookId = response.data?.notebook?.id;
            if (response.code !== 0 || !notebookId) throw new Error(response.msg || "笔记本创建失败");
            // 创建成功后才更新分组。绝不尝试直接写入思源的笔记本数据文件。
            this.assignments[notebookId] = groupId;
            if (this.order.indexOf(notebookId) === -1) this.order.push(notebookId);
            const group = this.groups.find(item => item.id === groupId);
            if (group) group.collapsed = false;
            await this.saveData(STORAGE_KEY, {groups: this.groups, assignments: this.assignments, order: this.order, ungroupedCollapsed: this.ungroupedCollapsed});
            if (this.isMobile) void this.refreshMobileNotebooks();
            else this.updateTree(true);
            showMessage(`已创建笔记本“${name}”`);
        } catch (error) {
            console.error("创建分组内笔记本失败", error);
            showMessage("创建笔记本或保存分组关系失败，请检查后重试；若已创建，请勿重复创建同名笔记本");
        }
    }

    // 思源 v3.8.x 移动端 MobileFiles：原生笔记本在 #sidebar 的 sidebar-file
    // 直属 .fn__flex-1 内，根节点直属子元素必须始终保持为原生 ul[data-url]。
    private findMobileTree(): HTMLElement | null {
        const sidebar = document.querySelector<HTMLElement>('#sidebar [data-type="sidebar-file"]');
        if (!sidebar) return null;
        const tree = Array.from(sidebar.children).find(el =>
            el.classList.contains("fn__flex-1") && el.tagName === "DIV");
        return tree as HTMLElement | null;
    }

    private rememberMobileStyle(el: HTMLElement) {
        if (!this.mobileNativeStyles.has(el)) this.mobileNativeStyles.set(el, {
            display: el.style.display, flexDirection: el.style.flexDirection,
            order: el.style.order, height: el.style.height, flexWrap: el.style.flexWrap,
        });
    }

    private restoreMobileTree() {
        this.cleanupMobileDrag();
        this.clearMobileRowBindings();
        this.mobileNativeBar?.remove();
        this.mobileNativeBar = null;
        this.mobileNativeFooter?.remove();
        this.mobileNativeFooter = null;
        const tree = this.mobileNativeTree;
        if (tree) {
            tree.querySelectorAll('.notebook-groups-native-heading').forEach(el => el.remove());
            tree.querySelectorAll('.notebook-groups-native-collapsed,.notebook-groups-native-leading').forEach(el =>
                el.classList.remove('notebook-groups-native-collapsed','notebook-groups-native-leading'));
        }
        for (const [el, original] of this.mobileNativeStyles) {
            el.style.display = original.display;
            el.style.flexDirection = original.flexDirection;
            el.style.order = original.order;
            el.style.height = original.height;
            el.style.flexWrap = original.flexWrap;
        }
        this.mobileNativeStyles.clear();
        this.mobileNativeTree = null;
        this.lastMobileSignature = "";
    }

    private mobileNativeRoots(tree: HTMLElement): HTMLUListElement[] {
        return Array.from(tree.children).filter((el): el is HTMLUListElement =>
            el.tagName === "UL" && el.hasAttribute("data-url") &&
            el.firstElementChild?.getAttribute("data-type") === "navigation-root");
    }

    // 在原生行监听整行长按拖动，短按时不阻止思源本来的点击行为。
    private bindNativeMobileRow(row: HTMLElement, kind: "group" | "notebook", id: string) {
        if (this.mobileRowBindings.has(row)) return;
        const allowed = (target: EventTarget | null) => {
            if (!(target instanceof Element) || this.nativeDocumentGesture || Date.now() < this.nativeDocumentDragUntil) return false;
            if (kind === "notebook") {
                // 只允许从“笔记本根行”自身发起拖拽。其后代的文档行即使冒泡到根行，
                // 也必须保留给思源原生文档拖动处理。
                if (row.getAttribute("data-type") !== "navigation-root" || target.closest("li") !== row) return false;
                if (target.closest('.notebook-groups-native-heading')) return false;
                const notebookRoot = row.closest('ul[data-url]');
                if (!notebookRoot || notebookRoot.parentElement !== this.mobileNativeTree) return false;
            }
            return !Boolean(target.closest('button:not(.notebook-groups-native-title), input, select, textarea,' +
                ' .b3-list-item__action, .b3-list-item__toggle, [contenteditable="true"]'));
        };
        const start = (x: number, y: number, pointerId: number) => {
            if (this.mobileDrag) return;
            const drag = {kind, id, pointerId, x, y, active: false,
                holdTimer: null as ReturnType<typeof setTimeout> | null};
            this.mobileDrag = drag;
            drag.holdTimer = setTimeout(() => {
                if (this.mobileDrag !== drag) return;
                drag.holdTimer = null;
                drag.active = true;
                this.showNativeMobileBadge(drag);
            }, 350);
        };
        const pointer = (event: PointerEvent) => {
            if (event.pointerType === "touch" || event.button !== 0 || !allowed(event.target)) return;
            start(event.clientX, event.clientY, event.pointerId);
            document.addEventListener("pointermove", this.onNativeMobileMove, true);
            document.addEventListener("pointerup", this.onNativeMobileUp, true);
            document.addEventListener("pointercancel", this.onNativeMobileCancel, true);
        };
        const touch = (event: TouchEvent) => {
            if (event.touches.length !== 1 || !allowed(event.target) || this.mobileDrag) return;
            // 思源 MobileFiles 在侧栏容器的冒泡阶段也会监听 touchstart，
            // 为原生笔记本启用另一套长按拖拽。仅在插件已经认领了
            // 「根笔记本行 / 分组标题」的触摸时截断冒泡，避免双重拖拽。
            // 不调用 preventDefault，短按后的原生 click、上下滑动仍可工作。
            // 文档行不会进入 allowed()，其全部触摸事件继续交给思源。
            event.stopPropagation();
            const t = event.changedTouches[0];
            this.mobileTouchId = t.identifier;
            start(t.clientX, t.clientY, -1);
            document.addEventListener("touchmove", this.onNativeMobileTouchMove, {capture: true, passive: false});
            document.addEventListener("touchend", this.onNativeMobileTouchEnd, true);
            document.addEventListener("touchcancel", this.onNativeMobileTouchEnd, true);
        };
        row.addEventListener("pointerdown", pointer);
        row.addEventListener("touchstart", touch, {capture: true, passive: true});
        this.mobileRowBindings.set(row, {pointer, touch});
    }
    private clearMobileRowBindings() {
        for (const [row, {pointer, touch}] of this.mobileRowBindings) {
            row.removeEventListener("pointerdown", pointer);
            row.removeEventListener("touchstart", touch, true);
        }
        this.mobileRowBindings.clear();
    }
    private findTrackedTouch(event: TouchEvent): Touch | null {
        for (const touch of Array.from(event.changedTouches)) {
            if (touch.identifier === this.mobileTouchId) return touch;
        }
        return null;
    }
    private readonly onNativeMobileTouchMove = (event: TouchEvent) => {
        if (this.nativeDocumentGesture) { this.cleanupMobileDrag(); return; }
        const touch = this.findTrackedTouch(event);
        if (!touch || !this.mobileDrag) return;
        const move = Math.hypot(touch.clientX - this.mobileDrag.x, touch.clientY - this.mobileDrag.y);
        if (!this.mobileDrag.active && move > 8) {this.cleanupMobileDrag(); return;}
        if (this.mobileDrag.active) {
            event.preventDefault();
            event.stopPropagation();
            this.onNativeMobileMove({pointerId: -1, clientX: touch.clientX, clientY: touch.clientY,
                preventDefault() {}, stopPropagation() {}} as PointerEvent);
        }
    };
    private readonly onNativeMobileTouchEnd = (event: TouchEvent) => {
        const touch = this.findTrackedTouch(event);
        if (!touch || !this.mobileDrag) return;
        if (event.type === "touchcancel") {this.cleanupMobileDrag(); return;}
        const wasActive = this.mobileDrag.active;
        if (wasActive) {
            event.preventDefault();
            event.stopPropagation();
            this.onNativeMobileUp({pointerId: -1, clientX: touch.clientX, clientY: touch.clientY,
                preventDefault() {}, stopPropagation() {}} as PointerEvent);
        } else this.cleanupMobileDrag();
    };

    private showNativeMobileBadge(drag: NonNullable<NotebookGroupsPlugin["mobileDrag"]>) {
        const badge = document.createElement("div");
        badge.className = "notebook-groups-mobile-drag-badge";
        badge.textContent = drag.kind === "group" ? "拖动分组排序" : "拖动笔记本分类／排序";
        badge.style.left = `${drag.x + 12}px`;
        badge.style.top = `${drag.y + 12}px`;
        document.body.appendChild(badge);
        this.mobileBadge = badge;
    }

    private createNativeGroupHeading(groupId: string, label: string, collapsed: boolean): HTMLElement {
        const heading = document.createElement("div");
        heading.className = "notebook-groups-native-heading";
        heading.dataset.groupId = groupId;
        // 分组是插件创建的节点，长按整行由插件独立处理。
        // 分组点击、＋按钮仍保持原来的操作。
        if (groupId) this.bindNativeMobileRow(heading, "group", groupId);
        const title = document.createElement("button");
        title.type = "button";
        title.className = "notebook-groups-native-title";
        title.textContent = `${collapsed ? "▸" : "▾"}  📁 ${label}`;
        title.addEventListener("click", event => {
            event.preventDefault(); event.stopPropagation();
            // 未分组始终展开，点击标题不执行折叠；其他分组照常切换。
            if (!groupId) return;
            const group = this.groups.find(item => item.id === groupId);
            if (!group) return;
            group.collapsed = !group.collapsed;
            void this.save();
            this.updateMobileTree(true);
        });
        heading.append(title);
        if (groupId) {
            const plus = this.button("＋", () => this.askName("新建笔记本", "", name => void this.createNotebook(groupId, name)));
            plus.className = "notebook-groups-native-plus";
            plus.title = "在此分组中新建笔记本";
            plus.setAttribute("aria-label", plus.title);
            heading.append(plus);
        }
        // 点击分组标题不能触发原生笔记本的打开／折叠事件。
        heading.addEventListener("click", event => event.stopPropagation());
        heading.addEventListener("touchstart", event => event.stopPropagation(), {passive: true});
        heading.addEventListener("touchmove", event => event.stopPropagation(), {passive: true});
        heading.addEventListener("touchend", event => event.stopPropagation());
        return heading;
    }

    private updateMobileTree(force: boolean) {
        if (!this.isMobile || this.mobileDrag || this.nativeDocumentGesture || Date.now() < this.nativeDocumentDragUntil) return;
        const tree = this.findMobileTree();
        if (!tree) return;
        if (this.mobileNativeTree && this.mobileNativeTree !== tree) this.restoreMobileTree();
        this.mobileNativeTree = tree;
        const roots = this.mobileNativeRoots(tree);
        const rootIds = roots.map(root => root.dataset.url || "").filter(Boolean);
        if (this.order.length === 0) this.order = [...rootIds];
        const signature = JSON.stringify({rootIds, groups: this.groups, assignments: this.assignments, order: this.order, ungroupedCollapsed: this.ungroupedCollapsed});
        // 思源自身可能用 innerHTML 重新创建笔记本节点，必须检查 DOM 装饰是否仍存在。
        const expectedDecorations = roots.length > 0 && !tree.querySelector('.notebook-groups-native-heading');
        if (!force && this.mobileNativeBar?.isConnected && !expectedDecorations && signature === this.lastMobileSignature) return;
        this.lastMobileSignature = signature;
        this.rememberMobileStyle(tree);
        tree.style.display = "flex";
        tree.style.flexDirection = "column";

        const sidebar = tree.parentElement;
        if (sidebar && !this.mobileNativeBar?.isConnected) {
            const bar = document.createElement("div");
            bar.className = "notebook-groups-native-bar";
            const label = document.createElement("strong");
            label.textContent = "笔记本分组";
            const manage = this.button("管理分组", () => this.openManager());
            bar.append(label, manage);
            sidebar.insertBefore(bar, tree);
            this.mobileNativeBar = bar;
        }
        this.clearMobileRowBindings();
        tree.querySelectorAll('.notebook-groups-native-heading').forEach(el => el.remove());
        roots.forEach(root => root.classList.remove('notebook-groups-native-collapsed','notebook-groups-native-leading'));
        const bookSort = (a: HTMLUListElement, b: HTMLUListElement) => {
            const ai = this.order.indexOf(a.dataset.url || "");
            const bi = this.order.indexOf(b.dataset.url || "");
            return (ai >= 0 ? ai : 100000 + roots.indexOf(a)) - (bi >= 0 ? bi : 100000 + roots.indexOf(b));
        };
        const validIds = new Set(this.groups.map(group => group.id));
        // 空分组不再放进顶部的特殊容器。它们与下一组的标题共享
        // 同一原生根节点的标题行，确保视觉顺序一致，同时不新增虚假笔记本 UL。
        const sections = [...this.groups.map(group => ({id: group.id, label: group.name, collapsed: group.collapsed})),
            {id: "", label: "未分组笔记本", collapsed: false}];
        const pendingHeadings: HTMLElement[] = [];
        let index = 0;
        this.mobileNativeFooter?.remove();
        this.mobileNativeFooter = null;
        // 清理回退版本遗留在工具栏的空分组标题。
        this.mobileNativeBar?.querySelector('.notebook-groups-native-empty-list')?.remove();
        for (const section of sections) {
            const members = roots.filter(root => {
                const raw = this.assignments[root.dataset.url || ""] || "";
                const gid = validIds.has(raw) ? raw : "";
                return gid === section.id;
            }).sort(bookSort);
            if (!members.length) {
                pendingHeadings.push(this.createNativeGroupHeading(section.id, section.label, section.collapsed));
                continue;
            }
            for (let i = 0; i < members.length; i++) {
                const root = members[i];
                const li = root.firstElementChild as HTMLElement;
                this.rememberMobileStyle(root);
                this.rememberMobileStyle(li);
                root.style.order = String(index++);
                if (section.collapsed) root.classList.add('notebook-groups-native-collapsed');
                if (i === 0) {
                    root.classList.add('notebook-groups-native-leading');
                    li.style.height = "auto";
                    li.style.flexWrap = "wrap";
                    // 插入同一级标题，后续分组顺序由 sections 自然决定。
                    const headings = [...pendingHeadings, this.createNativeGroupHeading(section.id, section.label, section.collapsed)];
                    li.prepend(...headings);
                    pendingHeadings.length = 0;
                }
                // 笔记本根行由插件处理长按；文档行继续交给思源。
                this.bindNativeMobileRow(li, "notebook", root.dataset.url || "");
            }
        }
        // 若末尾没有可承载标题的笔记本，则放在原生列表之后。
        // 此容器只是视觉上的分组标题，不参与思源的笔记本节点遍历。
        if (pendingHeadings.length) {
            const footer = document.createElement("div");
            footer.className = "notebook-groups-native-footer";
            footer.append(...pendingHeadings);
            tree.after(footer);
            this.mobileNativeFooter = footer;
        }
    }
    private lastMobileSignature = "";

    private nativeMobileTargetAt(x: number, y: number):
        | {kind: "group"; targetId: string; after: boolean; highlight: HTMLElement; edge: "before" | "after"}
        | {kind: "notebook"; position: DropPosition} | null {
        if (!this.mobileNativeTree || !this.mobileDrag) return null;
        const el = document.elementFromPoint(x, y);
        if (!(el instanceof Element)) return null;
        const heading = el.closest<HTMLElement>('.notebook-groups-native-heading');
        // 不把任何普通文档行当作笔记本排序的投放目标。
        // 只有分组标题与原生根笔记本行可以接收插件拖放。
        const row = el.closest<HTMLElement>('li[data-type]');
        if (!heading && row?.getAttribute('data-type') !== 'navigation-root') return null;
        const root = el.closest<HTMLUListElement>('ul[data-url]');
        if (!heading && (!root || root.parentElement !== this.mobileNativeTree)) return null;
        const targetId = heading?.dataset.groupId || root?.dataset.url || "";
        if (this.mobileDrag.kind === "group") {
            const gid = heading ? targetId : this.assignments[targetId];
            if (!gid) return null;
            const groupHeader = heading || this.mobileNativeTree.querySelector<HTMLElement>(
                `.notebook-groups-native-heading[data-group-id="${gid}"]`);
            if (!groupHeader) return null;
            const rect = groupHeader.getBoundingClientRect();
            const after = y > rect.top + rect.height / 2;
            return {kind: "group", targetId: gid, after, highlight: groupHeader, edge: after ? "after" : "before"};
        }
        const rawGroupId = this.assignments[targetId] || "";
        const groupId = heading ? targetId : (this.groups.some(g => g.id === rawGroupId) ? rawGroupId : "");
        if (heading || !root) return {kind: "notebook", position: {groupId, highlight: heading || this.mobileNativeTree}};
        const nativeRow = root.firstElementChild as HTMLElement;
        const rect = nativeRow.getBoundingClientRect();
        const before = y < rect.top + rect.height / 2;
        return {kind: "notebook", position: {
            groupId, ...(before ? {beforeId: targetId} : {afterId: targetId}),
            highlight: nativeRow, edge: before ? "before" : "after",
        }};
    }

    private clearMobileHighlight() {
        if (this.mobileDropHighlight) this.mobileDropHighlight.style.boxShadow = this.mobileDropShadow;
        this.mobileDropHighlight = null;
        this.mobileDropShadow = "";
    }

    private readonly onNativeMobileMove = (event: PointerEvent) => {
        if (this.nativeDocumentGesture) { this.cleanupMobileDrag(); return; }
        const drag = this.mobileDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
        if (!drag.active) {
            if (distance < 7) return;
            // 长按前滑动是页面滚动，不启动排序。
            if (drag.holdTimer) { this.cleanupMobileDrag(); return; }
            drag.active = true;
            this.showNativeMobileBadge(drag);
        }
        event.preventDefault(); event.stopPropagation();
        if (this.mobileBadge) {
            this.mobileBadge.style.left = `${event.clientX + 12}px`;
            this.mobileBadge.style.top = `${event.clientY + 12}px`;
        }
        const tree = this.mobileNativeTree;
        if (tree) {
            const bounds = tree.getBoundingClientRect();
            if (event.clientY < bounds.top + 40) tree.scrollTop -= 12;
            else if (event.clientY > bounds.bottom - 40) tree.scrollTop += 12;
        }
        const target = this.nativeMobileTargetAt(event.clientX, event.clientY);
        const highlight = target?.kind === "group" ? target.highlight : target?.position.highlight;
        const edge = target?.kind === "group" ? target.edge : target?.position.edge;
        const shadow = edge === "before" ? "inset 0 3px 0 var(--b3-theme-primary)" :
            edge === "after" ? "inset 0 -3px 0 var(--b3-theme-primary)" :
                "inset 0 0 0 2px var(--b3-theme-primary)";
        if (highlight !== this.mobileDropHighlight || (highlight && highlight.style.boxShadow !== shadow)) {
            this.clearMobileHighlight();
            if (highlight) {
                this.mobileDropHighlight = highlight;
                this.mobileDropShadow = highlight.style.boxShadow;
                highlight.style.boxShadow = shadow;
            }
        }
    };

    private readonly onNativeMobileUp = (event: PointerEvent) => {
        const drag = this.mobileDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.active) {
            event.preventDefault(); event.stopPropagation();
            this.suppressMobileClickUntil = Date.now() + 450;
        }
        const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 7;
        const target = drag.active && moved ? this.nativeMobileTargetAt(event.clientX, event.clientY) : null;
        this.cleanupMobileDrag();
        if (!target) return;
        if (target.kind === "group" && drag.kind === "group" && target.targetId !== drag.id) {
            void this.moveGroupTo(drag.id, target.targetId, target.after);
        } else if (target.kind === "notebook" && drag.kind === "notebook") {
            if (target.position.beforeId === drag.id || target.position.afterId === drag.id) return;
            void this.commitMove(drag.id, target.position);
        }
    };
    private readonly onNativeMobileCancel = (event: PointerEvent) => {
        if (this.mobileDrag?.pointerId === event.pointerId) this.cleanupMobileDrag();
    };
    private cleanupMobileDrag() {
        if (this.mobileDrag?.holdTimer) clearTimeout(this.mobileDrag.holdTimer);
        document.removeEventListener("pointermove", this.onNativeMobileMove, true);
        document.removeEventListener("pointerup", this.onNativeMobileUp, true);
        document.removeEventListener("pointercancel", this.onNativeMobileCancel, true);
        document.removeEventListener("touchmove", this.onNativeMobileTouchMove, true);
        document.removeEventListener("touchend", this.onNativeMobileTouchEnd, true);
        document.removeEventListener("touchcancel", this.onNativeMobileTouchEnd, true);
        this.mobileTouchId = null;
        this.clearMobileHighlight();
        this.mobileBadge?.remove();
        this.mobileBadge = null;
        this.mobileDrag = null;
    }
    private async refreshMobileNotebooks() {
        const requestId = ++this.mobileRefreshVersion;
        try {
            const response = await this.post<{notebooks: Notebook[]}>("/api/notebook/lsNotebooks", {});
            if (requestId !== this.mobileRefreshVersion) return;
            if (response.code !== 0 || !Array.isArray(response.data?.notebooks)) throw new Error(response.msg || "读取笔记本失败");
            this.mobileNotebooks = response.data.notebooks;
            this.updateMobileTree(true);
        } catch (error) { console.warn("手机端读取笔记本列表失败", error); }
    }

    private openManager() {
        const dialog = new Dialog({
            title: "管理笔记本分组",
            width: this.isMobile && window.innerWidth < 600 ? "calc(100vw - 20px)" : "520px",
            content: '<div class="b3-dialog__content notebook-groups-manager" style="padding:16px;max-height:60vh;overflow:auto"></div>',
        });
        const content = dialog.element.querySelector(".b3-dialog__content") as HTMLElement;
        const redraw = () => {
            content.replaceChildren();
            content.appendChild(this.button("＋ 新建分组", () => this.askName("新建分组", "", name => {
                this.groups.push({id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, collapsed: false});
                void this.save();
                this.updateTree(true);
                if (this.isMobile) void this.refreshMobileNotebooks();
                redraw();
            })));
            for (const group of this.groups) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--b3-border-color)" + (this.isMobile ? ";flex-wrap:wrap" : "");
                const label = document.createElement("span");
                label.textContent = group.name;
                label.style.flex = "1";
                row.append(label, this.button("重命名", () => this.askName("重命名分组", group.name, name => {
                    group.name = name;
                    void this.save();
                    this.updateTree(true);
                    if (this.isMobile) void this.refreshMobileNotebooks();
                    redraw();
                })), this.button("删除分组", () => {
                    siyuanConfirm("确认删除分组", `删除分组“${group.name}”？笔记本和文档都不会被删除。`, () => {
                        void (async () => {
                            const previousGroups = [...this.groups];
                            const previousAssignments = {...this.assignments};
                            this.groups = this.groups.filter(item => item.id !== group.id);
                            for (const id of Object.keys(this.assignments)) {
                                if (this.assignments[id] === group.id) delete this.assignments[id];
                            }
                            try {
                                await this.saveData(STORAGE_KEY, {groups: this.groups, assignments: this.assignments,
                                    order: this.order, ungroupedCollapsed: this.ungroupedCollapsed});
                                this.updateTree(true);
                                if (this.isMobile) void this.refreshMobileNotebooks();
                                redraw();
                                showMessage(`已删除分组“${group.name}”，笔记本已归入未分组`);
                            } catch (error) {
                                this.groups = previousGroups;
                                this.assignments = previousAssignments;
                                this.updateTree(true);
                                console.error("删除分组保存失败", error);
                                showMessage("删除失败，已恢复原分组");
                            }
                        })();
                    });
                }));
                if (this.isMobile) {
                    // 非触屏用户或不习惯拖动时，也能在管理弹窗里精确调整分组次序。
                    const idx = this.groups.findIndex(item => item.id === group.id);
                    if (idx > 0) row.appendChild(this.button("↑", () => {
                        void this.moveGroupTo(group.id, this.groups[idx - 1].id, false).then(redraw);
                    }));
                    if (idx < this.groups.length - 1) row.appendChild(this.button("↓", () => {
                        void this.moveGroupTo(group.id, this.groups[idx + 1].id, true).then(redraw);
                    }));
                }
                content.appendChild(row);
            }
            const subtitle = document.createElement("h4");
            subtitle.textContent = "设置每个笔记本所属分组";
            subtitle.style.margin = "14px 0 8px";
            content.appendChild(subtitle);
            const nodes = this.tree ? this.allNotebookElements(this.tree) : [];
            // 手机端不访问桌面原生文档树：管理弹窗使用手机 API 返回的笔记本列表。
            const books = this.isMobile ? this.mobileNotebooks : this.notebookNames(nodes);
            for (const book of books) {
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
                    if (this.isMobile) void this.refreshMobileNotebooks();
                });
                row.append(name, select);
                content.appendChild(row);
            }
        };
        redraw();
    }
}
