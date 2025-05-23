import type {Node, NodeType} from 'prosemirror-model';

import {type Logger2, globalLogger} from '../../../logger';
import {type UploadSuccessItem, getProportionalSize} from '../../../utils';
import {imageNodeName} from '../../markdown';
import {ImgSizeAttr} from '../../specs';

import {IMG_MAX_HEIGHT} from './const';

export function isImageNode(node: Node): boolean {
    return node.type.name === imageNodeName;
}

export type CreateImageNodeOptions = {
    needDimensions: boolean;
    enableNewImageSizeCalculation?: boolean;
};

export const createImageNode =
    (imgType: NodeType, opts: CreateImageNodeOptions, logger: Logger2.ILogger) =>
    async ({result, file}: UploadSuccessItem) => {
        const attrs: Record<string, string> = {
            [ImgSizeAttr.Src]: result.url,
            [ImgSizeAttr.Alt]: result.name ?? file.name,
        };
        if (opts.needDimensions) {
            try {
                const sizes = await loadImage(file).then(
                    opts.enableNewImageSizeCalculation ? getImageSizeNew : getImageSize,
                );
                Object.assign(attrs, sizes);
            } catch (err) {
                globalLogger.error(err);
                logger.error({error: err});
            }
        }
        return imgType.create(attrs);
    };

export async function loadImage(imgFile: File) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(imgFile);
        img.onload = () => {
            URL.revokeObjectURL(img.src);
            resolve(img);
        };
        img.onerror = (_e, _s, _l, _c, error) => reject(error);
    });
}

export function getImageSize(img: HTMLImageElement): {[ImgSizeAttr.Height]?: string} {
    return {height: String(Math.min(IMG_MAX_HEIGHT, img.height))};
}

export function getImageSizeNew({width, height}: HTMLImageElement): {
    [ImgSizeAttr.Width]?: string;
    [ImgSizeAttr.Height]?: string;
} {
    const size = getProportionalSize({
        width,
        height,
        imgMaxHeight: IMG_MAX_HEIGHT,
    });
    return {width: String(size.width), height: String(size.height)};
}
