
import ArrayBufferSlice from "../ArrayBufferSlice";
import { DataFetcher, NamedArrayBufferSlice } from "../DataFetcher";
import { GfxDevice, GfxFormat, GfxTexture, makeTextureDescriptor2D } from "../gfx/platform/GfxPlatform";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { SceneGfx } from "../viewer";
import { getFileFromZip, parseZipFile } from "../ZipFile";
import { ObjFile, parseDump } from "./bin";
import { Scene } from "./render";
// import { Scene } from "./render";

const pathBase = `SlyDump`;

// TODO: move to common (copied from foxfur)
function fetchImage(dataFetcher: DataFetcher, path: string): Promise<ImageData> {
    path = dataFetcher.getDataURLForPath(path);
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.src = path;
    const p = new Promise<ImageData>((resolve) => {
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, img.width, img.height));
        };
    });
    return p;
}

export class SlyDumpSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string = id, private compressed: boolean = false) {
    }

    public async createScene(device: GfxDevice, sceneContext: SceneContext): Promise<SceneGfx> {
        let objFileData: ArrayBufferSlice;

        if (this.compressed) {
            const zip = parseZipFile(await sceneContext.dataFetcher.fetchData(`${pathBase}/${this.id}.zip`));
            objFileData = getFileFromZip(zip, `${this.id}.obj`);
        } else {
            objFileData = await sceneContext.dataFetcher.fetchData(`${pathBase}/${this.id}.obj`);
        }

        var dec = new TextDecoder("utf-8");
        const obj = new ObjFile(dec.decode(objFileData.createDataView())).parse();

        let textures = new Map<string, ImageData>();
        for (let materialName of obj.materials) {
            if (materialName == "0x0")
                continue;
            const texturePath = `${pathBase}/${this.id}/${materialName}.png`;
            try {
                const imageData = await fetchImage(sceneContext.dataFetcher, texturePath);
                textures.set(materialName, imageData);
            } catch (e: unknown) {
                console.error(e);
                continue;
            }
        }
        const dumpChunks = parseDump(obj);

        return new Scene(device, dumpChunks, textures);
    }
}

const sceneDescs = [
    new SlyDumpSceneDesc('0', '5. Blood Bath Bay (from "Dead Men Tell No Tales")', true),
    new SlyDumpSceneDesc('1', 'testing', false),
];

const id = 'SlyDump';
const name = "Sly 3: Honor Among Thieves";
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
