
import ArrayBufferSlice from "../ArrayBufferSlice";
import { DataFetcher, NamedArrayBufferSlice } from "../DataFetcher";
import { GfxDevice, GfxFormat, GfxTexture, makeTextureDescriptor2D } from "../gfx/platform/GfxPlatform";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { SceneGfx } from "../viewer";
import { getFileFromZip, parseZipFile } from "../ZipFile";
import { ObjFile, parseDump } from "./bin";
import { Scene } from "./render";

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
            objFileData = getFileFromZip(zip, `${this.id.split('/')[1]}.obj`);
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
    "Main Hub Areas",
    new SlyDumpSceneDesc('sly3_1_m_ext_hub/0', 'Kaine Island, South Pacific (from Prologue "Beginning of the End")', true),
    new SlyDumpSceneDesc('sly3_3_v_ext_hub/0', 'Venice, Italy (from Ep.1 "An Opera of Fear")', true),
    new SlyDumpSceneDesc('sly3_4_o_ext_hub/0', 'Yuendumu, Australia (from Ep.2 "Rumble Down Under")', true),
    new SlyDumpSceneDesc('sly3_5_h_ext_hub/0', 'Kinderdijk, Holland (from Ep.3 "Flight of Fancy")', true),
    new SlyDumpSceneDesc('sly3_6_c_ext_hub/0', 'Kunlun Mountains, China (from Ep.4 "A Cold Alliance")', true),
    new SlyDumpSceneDesc('sly3_7_p_ext_hub/0', 'Blood Bath Bay (from Ep.5 "Dead Men Tell No Tales")', true),
    new SlyDumpSceneDesc('sly3_1_m_ext_hub/0', 'Kaine Island, South Pacific (from Ep.6 "Honor Among Thieves")', true),

    "Jobs",
    new SlyDumpSceneDesc('TODO', 'TODO', true),
    "Main Hub Area day variations",
    new SlyDumpSceneDesc('TODO', 'TODO', true),
    "Master Thief Challenges",
    new SlyDumpSceneDesc('TODO', 'TODO', true),

    "Other",
    new SlyDumpSceneDesc('sly3_2_i_trainer_hub/0', 'Unknown (Hazard Room)', false),

    // "Debug",
    // new SlyDumpSceneDesc('sly3_1_m_ext_hub/1', 'Kaine Island, South Pacific (from Prologue "Beginning of the End")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/1', 'Blood Bath Bay (from Ep.5 "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/2', 'Blood Bath Bay (from Ep.5 "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_5_h_ext_hub/0', 'flight of fancy', false),
    // new SlyDumpSceneDesc('sly3_5_h_ext_hub/1', '1 flight of fancy', false),
    // new SlyDumpSceneDesc('sly3_5_h_ext_hub/2', '2 flight of fancy', false),
    // new SlyDumpSceneDesc('sly3_5_h_ext_hub/3', '3. Kinderdijk, Holland (from "5. Flight of Fancy")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/0', '5. Blood Bath Bay (from "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/1', 'reord 5. Blood Bath Bay (from "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/2', 'reord2 5. Blood Bath Bay (from "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/3', 'reord3 5. Blood Bath Bay (from "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/4', 'reord4 5. Blood Bath Bay (from "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_7_p_ext_hub/5', 'reord5 5. Blood Bath Bay (from "Dead Men Tell No Tales")', false),
    // new SlyDumpSceneDesc('sly3_1_m_ext_hub/0', '6. Kaine Island (from "Honor Among Thieves")', false),

    // new SlyDumpSceneDesc('0', '0', false),
    // new SlyDumpSceneDesc('1', '1', false),
    // new SlyDumpSceneDesc('2', '2', false),
];

const id = 'SlyDump';
const name = "Sly 3: Honor Among Thieves";
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
