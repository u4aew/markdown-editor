import type {Node, Schema} from 'prosemirror-model';
import {type EditorState, Plugin, PluginKey, type Transaction} from 'prosemirror-state';
// @ts-ignore // TODO: fix cjs build
import {findChildren, findParentNodeClosestToPos} from 'prosemirror-utils';
import {Decoration, DecorationSet} from 'prosemirror-view';

import {cn} from '../../../classname';
import type {ExtensionAuto} from '../../../core';
import {isEqual} from '../../../lodash';
import {isNodeEmpty} from '../../../utils/nodes';
import {type PlaceholderOptions, getPlaceholderContent} from '../../../utils/placeholder';
import {isTextSelection} from '../../../utils/selection';

import './index.scss';

const getPlaceholderPluginKeys = (schema: Schema) => {
    const pluginKeys = [];
    for (const node in schema.nodes) {
        if (schema.nodes[node]) {
            const spec = schema.nodes[node].spec;
            if (spec.placeholder?.customPlugin) {
                pluginKeys.push(spec.placeholder.customPlugin);
            }
        }
    }

    return pluginKeys;
};

const b = cn('placeholder');

export const createPlaceholder = (node: Node, parent: Node | null, focus?: boolean) => {
    const content = getPlaceholderContent(node, parent);
    if (!content) return null;

    const placeholder = document.createElement('div');
    placeholder.className = b({focus});

    const placeholderCursor = document.createElement('span');
    placeholderCursor.className = b('cursor');

    const placeholderText = document.createElement('span');
    placeholderText.className = b('text');
    placeholderText.textContent = content;

    placeholder.append(placeholderCursor, placeholderText);

    return placeholder;
};

const placeholderNeeded = (node: Node) => {
    const childrenWithPlaceholderVisible = findChildren(node, (n: Node) =>
        Boolean(n.type.spec.placeholder?.alwaysVisible),
    );

    return (
        isNodeEmpty(node) &&
        // If there are child nodes with constant placeholder - give them the priority
        !childrenWithPlaceholderVisible.length
    );
};

const addDecoration = (
    widgetsMap: WidgetsMap,
    node: Node,
    pos: number,
    parent: Node | null,
    cursorPos: number | null | undefined,
    globalState: ApplyGlobalState,
) => {
    const placeholderSpec = node.type.spec.placeholder;
    const decorationPosition = pos + node.childCount + 1;

    // We do not add decoration if there is already a placeholder at this position
    if (!placeholderSpec || widgetsMap[decorationPosition]) return;

    if (placeholderSpec.customPlugin) {
        widgetsMap[decorationPosition] = placeholderSpec.customPlugin;
        return;
    }

    const focus = decorationPosition === cursorPos;

    const placeholderDOM = createPlaceholder(node, parent, focus);
    if (!placeholderDOM) return;

    if (focus) globalState.hasFocus = true;

    widgetsMap[decorationPosition] = {
        pos: decorationPosition,
        toDOM: placeholderDOM,
        spec: {focus},
    };
};

type ApplyGlobalState = {hasFocus: boolean};

type DecoWidgetParameters = Parameters<typeof Decoration.widget>;
type WidgetSpec = {
    pos: DecoWidgetParameters[0];
    toDOM: DecoWidgetParameters[1];
    spec?: DecoWidgetParameters[2];
};

type PlaceholderPluginState = {decorationSet: DecorationSet; hasFocus: boolean};

type WidgetsMap = Record<number, WidgetSpec | PluginKey>;

const pluginKey = new PluginKey<PlaceholderPluginState>('placeholder_plugin');

export const Placeholder: ExtensionAuto<PlaceholderOptions> = (builder, opts) => {
    builder.context.set('placeholder', opts);
    builder.addPlugin(
        () =>
            new Plugin<PlaceholderPluginState>({
                key: pluginKey,
                props: {
                    attributes(state) {
                        const attrs: Record<string, string> = {};
                        if (pluginKey.getState(state)!.hasFocus) {
                            // hide native cursor
                            attrs.class = 'g-md-editor-hidecursor';
                        }
                        return attrs;
                    },
                    decorations(state) {
                        return pluginKey.getState(state)?.decorationSet;
                    },
                },
                state: {
                    init: (_config, state) => initState(state),
                    apply: applyState,
                },
            }),
        builder.Priority.VeryHigh,
    );
};

function getPlaceholderWidgetSpecs(state: EditorState) {
    const globalState: ApplyGlobalState = {hasFocus: false};
    const widgetsMap: WidgetsMap = {};
    const {selection} = state;
    const cursorPos = isTextSelection(selection) ? selection.$cursor?.pos : null;

    getPlaceholderPluginKeys(state.schema).forEach((f) => {
        // We use find because it can be used to iterate over the DecorationSet.
        f.getState(state)?.find(undefined, undefined, (spec) => {
            widgetsMap[spec.pos] = f;
            return false;
        });
    });

    // Fraw placeholder for all nodes where placeholder is alwaysVisible
    const decorate = (node: Node, pos: number, parent: Node | null) => {
        const placeholderSpec = node.type.spec.placeholder;

        if (placeholderSpec && placeholderSpec.alwaysVisible && placeholderNeeded(node)) {
            addDecoration(widgetsMap, node, pos, parent, cursorPos, globalState);
        }
    };

    state.doc.descendants(decorate);

    const parentNode = findParentNodeClosestToPos(state.selection.$from, (node: Node) => {
        return Boolean(node.type.spec.placeholder);
    });

    const placeholderSpec = parentNode?.node.type.spec.placeholder;

    // Draw placeholder if it needs to be draw in the place of cursor
    if (
        parentNode &&
        placeholderNeeded(parentNode.node) &&
        placeholderSpec &&
        !placeholderSpec.alwaysVisible
    ) {
        const {node, pos, depth} = parentNode;
        const parent = depth > 0 ? state.selection.$from.node(depth - 1) : null;
        addDecoration(widgetsMap, node, pos, parent, cursorPos, globalState);
    }

    const widgetSpecs = Object.values(widgetsMap).filter(
        (decoration) => !(decoration instanceof PluginKey),
    ) as WidgetSpec[];

    return {widgetSpecs, hasFocus: globalState.hasFocus};
}

function initState(state: EditorState): PlaceholderPluginState {
    const {widgetSpecs, hasFocus} = getPlaceholderWidgetSpecs(state);
    const decorationSet = DecorationSet.create(
        state.doc,
        widgetSpecs.map((widget) => Decoration.widget(widget.pos, widget.toDOM, widget.spec)),
    );

    return {decorationSet, hasFocus};
}

function applyState(
    tr: Transaction,
    oldPluginState: PlaceholderPluginState,
    _oldState: EditorState,
    newState: EditorState,
): PlaceholderPluginState {
    const {widgetSpecs, hasFocus} = getPlaceholderWidgetSpecs(newState);
    const {decorationSet} = oldPluginState;
    const oldMappedSet = decorationSet.map(tr.mapping, tr.doc);

    // Find all decorations that are present in old and new set
    const decorationsThatDidNotChange = widgetSpecs.reduce((a: Decoration[], {pos, spec}) => {
        const deco = oldMappedSet.find(pos, pos);
        if (deco.length && isEqual(deco[0].spec, spec)) a.push(...deco);
        return a;
    }, []);

    // Those are decorations that are presenr only in new set
    const newAddedDecorations = widgetSpecs.filter(
        ({pos}) => !decorationsThatDidNotChange.map(({from}) => from).includes(pos),
    );

    // That is a set with decorations that are present in old set and absent in new set
    const notRelevantDecorations = oldMappedSet.remove(decorationsThatDidNotChange);
    let newSet = oldMappedSet;
    // Remove decorations that are not present in new set
    if (notRelevantDecorations.find().length) newSet = newSet.remove(notRelevantDecorations.find());
    // Add new decorations
    if (newAddedDecorations.length)
        newSet = newSet.add(
            tr.doc,
            newAddedDecorations.map((widget) =>
                Decoration.widget(widget.pos, widget.toDOM, widget.spec),
            ),
        );

    return {decorationSet: newSet, hasFocus};
}

declare module 'prosemirror-model' {
    interface NodeSpec {
        placeholder?: {
            content: string | ((node: Node, parent?: Node | null) => string | null);
            customPlugin?: PluginKey<DecorationSet>;
            alwaysVisible?: boolean;
        };
    }
}

declare global {
    namespace WysiwygEditor {
        interface Context {
            placeholder: PlaceholderOptions;
        }
    }
}
