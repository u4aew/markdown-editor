import type {PresetName} from 'markdown-it';
import {EditorState} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';

import type {CommonEditor, ContentHandler, MarkupString} from '../common';
import {Logger2} from '../logger';

import type {ActionsManager} from './ActionsManager';
import {WysiwygContentHandler} from './ContentHandler';
import {ExtensionsManager} from './ExtensionsManager';
import {SchemaDynamicModifier} from './SchemaDynamicModifier';
import {MarkdownParserDynamicModifier} from './markdown/MarkdownParser';
import {MarkdownSerializerDynamicModifier} from './markdown/MarkdownSerializerDynamicModifier';
import type {TransformFn} from './markdown/ProseMirrorTransformer';
import type {ActionStorage} from './types/actions';
import type {DynamicModifiers} from './types/dynamicModifiers';
import type {Extension} from './types/extension';
import type {Parser} from './types/parser';
import type {Serializer} from './types/serializer';
import {bindActions} from './utils/actions';
import {convertDynamicModifiersConfigs} from './utils/dynamicModifiers';
import {LoggerFacet} from './utils/logger';
import {logTransactionMetrics} from './utils/metrics';

type OnChange = (editor: WysiwygEditor) => void;

export type EscapeConfig = {
    commonEscape?: RegExp;
    startOfLineEscape?: RegExp;
};

export type WysiwygEditorOptions = {
    domElem?: Element;
    /** markdown markup */
    initialContent?: string;
    extensions?: Extension;
    /** @default 'default' */
    mdPreset?: PresetName;
    allowHTML?: boolean;
    linkify?: boolean;
    pmTransformers?: TransformFn[];
    linkifyTlds?: string | string[];
    escapeConfig?: EscapeConfig;
    /** Call on any state change (move cursor, change selection, etc...) */
    onChange?: OnChange;
    /** Call only if document change */
    onDocChange?: OnChange;
    /** @internal Modifiers adjust the parser and serializer */
    modifiers?: DynamicModifiers[];
    logger?: Logger2.ILogger;
};

export class WysiwygEditor implements CommonEditor, ActionStorage {
    #view: EditorView;
    #serializer: Serializer;
    #parser: Parser;
    #actions: ActionsManager;
    #contentHandler: ContentHandler;
    #escapeConfig?: EscapeConfig;

    get dom() {
        return this.#view.dom;
    }

    get serializer() {
        return this.#serializer;
    }

    get parser() {
        return this.#parser;
    }

    get actions() {
        return this.#actions.actions;
    }

    /** @internal used for prosemirror-dev-tools in demo */
    get view() {
        return this.#view;
    }

    constructor({
        domElem,
        initialContent = '',
        extensions = () => {},
        allowHTML,
        mdPreset,
        linkify,
        pmTransformers,
        linkifyTlds,
        escapeConfig,
        onChange,
        onDocChange,
        modifiers,
        logger = new Logger2(),
    }: WysiwygEditorOptions) {
        const dynamicModifiersConfig = modifiers
            ? convertDynamicModifiersConfigs(modifiers)
            : undefined;
        const dynamicModifiers = dynamicModifiersConfig
            ? {
                  schema: new SchemaDynamicModifier(dynamicModifiersConfig.schema),
                  parser: new MarkdownParserDynamicModifier(dynamicModifiersConfig.parser),
                  serializer: new MarkdownSerializerDynamicModifier(
                      dynamicModifiersConfig.serializer,
                  ),
              }
            : undefined;

        const {
            schema,
            markupParser: parser,
            serializer,
            nodeViews,
            markViews,
            plugins,
            rawActions,
            actions,
        } = ExtensionsManager.process(
            extensions,
            {
                // "breaks" option only affects the renderer, but not the parser
                mdOpts: {html: allowHTML, linkify, breaks: true, preset: mdPreset},
                linkifyTlds,
                pmTransformers,
                dynamicModifiers,
            },
            logger,
        );

        plugins.unshift(LoggerFacet.of(logger));

        const state = EditorState.create({
            schema,
            doc: parser.parse(initialContent),
            plugins,
        });

        const thisOnChange = () => this.tryOnChange(onChange);
        const thisOnDocChange = () => this.tryOnChange(onDocChange);

        this.#view = new EditorView(domElem ?? null, {
            state,
            nodeViews,
            markViews,
            dispatchTransaction(tr) {
                const newState = this.state.apply(tr);
                // @ts-expect-error
                this.updateState(newState);
                thisOnChange();
                if (tr.docChanged) {
                    thisOnDocChange();
                }
                logTransactionMetrics(tr, logger);
            },
        });
        this.#actions = actions.setActions(
            bindActions<keyof WysiwygEditor.Actions>(rawActions)(
                this.#view,
            ) as WysiwygEditor.Actions,
        );
        this.#serializer = serializer;
        this.#parser = parser;
        this.#contentHandler = new WysiwygContentHandler(this.#view, parser);
        this.#escapeConfig = escapeConfig;
    }

    action<T extends keyof WysiwygEditor.Actions>(actionName: T): WysiwygEditor.Actions[T] {
        return this.#actions.action(actionName);
    }

    focus() {
        return this.#view.focus();
    }

    hasFocus() {
        return this.#view.hasFocus();
    }

    getValue(): MarkupString {
        return this.#serializer.serialize(this.#view.state.doc, this.#escapeConfig);
    }

    isEmpty(): boolean {
        const {doc} = this.#view.state;
        return (
            doc.childCount === 1 &&
            doc.firstChild?.type.name === 'paragraph' &&
            doc.firstChild.childCount === 0
        );
    }

    clear(): void {
        return this.#contentHandler.clear();
    }

    replace(newMarkup: MarkupString): void {
        return this.#contentHandler.replace(newMarkup);
    }

    prepend(markup: MarkupString): void {
        return this.#contentHandler.prepend(markup);
    }

    append(markup: MarkupString): void {
        return this.#contentHandler.append(markup);
    }

    moveCursor(position: 'start' | 'end'): void {
        return this.#contentHandler.moveCursor(position);
    }

    destroy() {
        this.#view.destroy();
    }

    private tryOnChange(cb?: OnChange) {
        if (cb) {
            try {
                cb(this);
            } catch (err) {
                console.error(err);
            }
        }
    }
}

declare global {
    namespace WysiwygEditor {
        // eslint-disable-next-line @typescript-eslint/no-empty-interface
        interface Actions {}
    }
}
