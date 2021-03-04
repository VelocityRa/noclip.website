import ArrayBufferSlice from '../ArrayBufferSlice';
import { mat4, vec2, vec3 } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import { IS_DEVELOPMENT } from "../BuildVersion";
import { assert, hexzero, hexzero0x, leftPad } from '../util';
import { NamedArrayBufferSlice } from "../DataFetcher";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end } from '../MathHelpers';
import { downloadBuffer } from '../DownloadUtils';
import { makeZipFile, ZipFileEntry } from '../ZipFile';
import { SlyRenderer } from './SlyRenderer';
import * as Settings from './SlyConstants';
import * as Data from './SlyData';
import { DataStream } from "./DataStream";
import { sprintf } from "./sprintf";

const pathBase = `Sly2`;

// TODO: move to other file
interface LevelObject {
    name: string;
    type: string; // char
    count: number;
}
function parseObjectTable(stream: DataStream): LevelObject[] {
    let objects: LevelObject[] = [];

    let objCount = stream.readUint16();
    for (let i = 0; i < objCount; ++i) {
        let resourceDescriptorStr = stream.readString(0x40);
        let type = resourceDescriptorStr[3];
        let name = resourceDescriptorStr.substr(4);
        stream.skip(4 * 4);
        let count = stream.readUint32();
        objects.push({name, type, count});
    }

    return objects;
}

class Sly2LevelSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.slyZ.dec`)

        console.log(`loaded ${pathBase}/${this.id} of size ${bin.byteLength}`);
        Uint8Array.toString()
        let stream = new DataStream(bin);

        let objects = parseObjectTable(stream);
        console.log(objects);

        const renderer = new SlyRenderer(device, [], [], [], [], []);
        return renderer;
    }
}

// From https://docs.google.com/spreadsheets/d/1bdhTl2IvXVWOjnjhpgUTH0kg6e-RcioezIYrsi-_mso/edit#gid=0
// TODO: Should titles be world titles instead of ep?
const sceneDescs = [
    "The Black Chateau (Paris, France)",
    new Sly2LevelSceneDesc("f_nightclub_exterior", "The Black Chateau (Extermal)"),
];

const id = 'Sly2';
const name = 'Sly 2: Band of Thieves';
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
