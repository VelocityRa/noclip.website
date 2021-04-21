import ArrayBufferSlice from '../ArrayBufferSlice';
import { mat4, vec2, vec3 } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import { IS_DEVELOPMENT } from "../BuildVersion";
import { assert, hexzero, hexzero0x, leftPad, spacePad } from '../util';
import { NamedArrayBufferSlice } from "../DataFetcher";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end } from '../MathHelpers';
import { downloadBuffer } from '../DownloadUtils';
import { makeZipFile, ZipFileEntry } from '../ZipFile';
import { Sly2Renderer } from './Sly2Renderer';
import { Texture } from './SlyData';
import { DataStream } from "./DataStream";
import { sprintf } from "./sprintf";

const pathBase = `Sly2`;

// Research at: https://github.com/VelocityRa/SlyTools/blob/main/templates/sly2_ps3_level.bt

let enc = new TextEncoder();

// TODO: move shit to other files

interface ObjectEntry {
    index: number;
    name: string;
    type: string; // char
    id0: number;
    count: number;
}
function parseObjectEntries(s: DataStream): ObjectEntry[] {
    let objects: ObjectEntry[] = [];

    const objectCount = s.u16();
    for (let i = 0; i < objectCount; ++i) {
        const resourceDescriptorStr = s.readString(0x40);
        const type = resourceDescriptorStr[3];
        const name = resourceDescriptorStr.substr(4);

        s.skip(2 * 4);
        const id0 = s.u32();
        s.skip(1 * 4);

        const count = s.u32();

        objects.push({ index: i, name, type, id0, count });
    }

    return objects;
}

class SzmeK13 {
    constructor(s: DataStream) {
        const k0Count = s.u16();
        if (k0Count > 0) {
            for (let i = 0; i < k0Count; i++) {
                const k11Count = s.u16();
                for (let j = 0; j < k11Count; j++) {
                    s.skip(2 + 2 + 1);
                }
            }

            let k12Count = s.u16();
            s.skip(k12Count * 2);
        }
    }
}

class SzmeChunk {
    public textureId0: (number | null) = null;
    public textureId1: (number | null) = null;

    constructor(s: DataStream, flags: number, instanceCount: number, e2Count: number, i0: number) {
        const a0Count = s.u8();

        let a0UnkCount = 0;

        for (let i = 0; i < a0Count; ++i) {
            const a0x = s.u32();
            const a0y = s.u32();
            const a0z = s.u32();

            if (i == 0)
                this.textureId0 = a0y;
            else if (i == 1)
                this.textureId1 = a0y;

            a0UnkCount += a0x;
        }

        const vertexCount = s.u8();
        s.skip(vertexCount * 3 * 4); // positions
        s.skip(vertexCount * 2 * 4); // texcoords
        s.skip(vertexCount * 3 * 4); // normals
        s.skip(vertexCount * 4);     // unk (a4)

        s.skip(1);

        if (e2Count > 0) {
            s.skip(4);

            const e2CountMin = Math.min(e2Count, 4);
            s.skip(vertexCount * e2CountMin);
        }

        s.skip(a0UnkCount);

        const uVar28 = a0UnkCount + 0x1F;
        const uVar29 = (uVar28 < 0 && (uVar28 & 0x1f) != 0) ? 1 : 0;
        const a6UintCount = (uVar28 >> 5) + uVar29;

        s.skip(a6UintCount * 4);
    }
}

class Szme {
    public offset: number;
    public flags: number;

    public chunks: SzmeChunk[] = [];

    constructor(s: DataStream, instanceCount: number, i0: number) {
        this.offset = s.offs;

        if (s.readUint32() != Mesh.szmeMagic) {
            debugger;
            throw new Error(`bad SZME magic at ${hexzero0x(this.offset)}`);
        }

        this.flags = s.u8();
        s.skip(2);

        const e2Count = s.u8();
        s.skip(e2Count * (4 + 2));

        const e3 = s.u8();
        if (e3 != 0xFF) {
            const e4 = s.vec3();
            const e5 = s.vec2();
            const e6 = s.vec3();
        }

        const k13 = new SzmeK13(s);

        if ((this.flags & 0x4) != 0) {
            const e7 = s.u32();
            const e8 = s.u8();

            if (e8 != 0xFF) {
                s.skip(4 + 4 + 4 + 4 + 3 * 4 * 4);
            }

            s.skip(1 + 1 + 1);
        }

        const szmeDataCount = s.u16();
        for (let i = 0; i < szmeDataCount; ++i) {
            const szmeChunk = new SzmeChunk(s, this.flags, instanceCount, e2Count, i0);
            this.chunks.push(szmeChunk);
        }
    }
}

interface MeshChunk {
    positions: Float32Array; // vec3
    normals: Float32Array;  // vec3
    texCoords: Float32Array;  // vec2
    vertexColor: Uint32Array; // RGBA (?)
    vertexColorFloats: Float32Array;   // vec4

    trianglesIndices1: Uint16Array;
    unkIndices1: Uint16Array;
    trianglesIndices2: Uint16Array;
    unkIndices2: Uint16Array;

    name: string; // for debugging
}


interface MeshC2Entry {
    transformMatrix: (mat4 | null);
}

// TODO: is u6 & g4 texture ID?

// TODO: type==3 p6 p5 is tristrip
// TODO: maybe u9 is local offset?

class Mesh {
    static readonly szmsMagic = 0x534D5A53; // "SZMS"
    static readonly szmeMagic = 0x454d5a53; // "SZME"
    static readonly szmsVersion = 4;

    public offset: number;

    public type: number;

    public chunks: MeshChunk[] = [];
    public szme: Szme;

    public u0: number;

    public instanceCount: number;
    public instances: mat4[] = [];

    public containerInstanceMatrixIndex: number;

    constructor(s: DataStream, public readonly container: MeshContainer, public meshIndex: number, i0: number) {
        this.offset = s.offs;

        this.u0 = s.u8();

        if (this.u0 == 0) {
            this.type = s.u8();
            this.instanceCount = s.u16();
            this.containerInstanceMatrixIndex = s.u16();
            s.skip(1);
            const u4 = s.f32();
            const u5 = s.f32();
            const u6 = s.u32();
            s.skip(1 + 1);

            if (i0 == 0) {
                const u9 = s.vec3();
                const u10 = s.f32();
                const u11 = s.u32();
                const u12 = s.f32();
            }

            if (this.type == 0) {
                // Read SZMS header

                if (s.u32() != Mesh.szmsMagic)
                    throw new Error(`[${hexzero0x(s.offs)}] bad SZMS magic`);

                if (s.u32() != 0x4)
                    throw new Error(`[${hexzero0x(s.offs)}] unsupported version`);


                const totalSize = s.u32();

                // Read mesh header

                const startOffs = s.offs;

                const unkMhdr0x00 = s.u32();
                const unkMhdr0x04 = s.u16();
                const szmsChunkCount = s.u16();

                let meshOffsets: number[] = [];

                for (let i of range_end(0, szmsChunkCount)) {
                    meshOffsets.push(s.u32());
                }

                // console.log(sprintf('SZMS #%04d %05X %08X %s', index, totalSize, offset, meshOffsets));

                for (let meshOffs of meshOffsets) {
                    s.offs = startOffs + meshOffs;

                    // Read vertex header

                    const unkVtxHdr0x00 = s.u32();
                    const vertexCount = s.u16();
                    const unkVtxHdrCount = s.u16();
                    const vertexDataOffset = s.u32();
                    const indexHeaderOffset = s.u32();

                    const vertexDataSize = indexHeaderOffset - vertexDataOffset;

                    s.offs = startOffs + vertexDataOffset;

                    // Read vertex data

                    let positions = new Float32Array(vertexCount * 3);
                    let normals = new Float32Array(vertexCount * 3)
                    let texCoords = new Float32Array(vertexCount * 2);
                    let vertexColor = new Uint32Array(vertexCount);
                    let vertexColorFloats = new Float32Array(vertexCount * 4);

                    for (let i = 0; i < vertexCount; ++i) {
                        positions[i * 3 + 0] = s.f32();
                        positions[i * 3 + 1] = s.f32();
                        positions[i * 3 + 2] = s.f32();

                        normals[i * 3 + 0] = s.f32();
                        normals[i * 3 + 1] = s.f32();
                        normals[i * 3 + 2] = s.f32();

                        texCoords[i * 2 + 0] = s.f32();
                        texCoords[i * 2 + 1] = s.f32();

                        vertexColor[i] = s.u32();

                        s.offs -= 4;
                        vertexColorFloats[i * 4 + 0] = s.u8() / 255;
                        vertexColorFloats[i * 4 + 1] = s.u8() / 255;
                        vertexColorFloats[i * 4 + 2] = s.u8() / 255;
                        vertexColorFloats[i * 4 + 3] = s.u8() / 255;
                    }

                    s.offs = startOffs + indexHeaderOffset;

                    const triangleCount1 = s.u16() * 3;
                    const indexCount1 = s.u16();
                    const triangleDataOffset1 = s.u32();
                    const indexDataOffset1 = s.u32();

                    const triangleCount2 = s.u16() * 3;
                    const indexCount2 = s.u16();
                    const triangleDataOffset2 = s.u32();
                    const indexDataOffset2 = s.u32();

                    // Read triangle data 1
                    s.offs = startOffs + triangleDataOffset1;
                    const trianglesIndices1 = new Uint16Array(triangleCount1);
                    for (let i = 0; i < triangleCount1; ++i) {
                        trianglesIndices1[i] = s.u16();
                    }
                    // Read index data 1
                    s.offs = startOffs + indexDataOffset1;
                    const unkIndices1 = new Uint16Array(indexCount1);
                    for (let i of range_end(0, indexCount1)) {
                        unkIndices1[i] = s.u16();
                    }
                    // Read triangle data 2
                    s.offs = startOffs + triangleDataOffset2;
                    const trianglesIndices2 = new Uint16Array(triangleCount2);
                    for (let i = 0; i < triangleCount2; ++i) {
                        trianglesIndices2[i] = s.u16();
                    }
                    // Read index data 2
                    s.offs = startOffs + indexDataOffset2;
                    let unkIndices2 = new Uint16Array(indexCount2);
                    for (let i of range_end(0, indexCount2)) {
                        unkIndices2[i] = s.u16();
                    }

                    let meshAddr = startOffs - 2;
                    let submeshAddr = startOffs + meshOffs;
                    let submeshCount = spacePad(meshOffsets.length.toString(), 2);

                    let name = `SZMS ${hexzero(meshAddr, 6)} ${submeshCount} | ${hexzero(submeshAddr)}`;

                    this.chunks.push({
                        positions, normals, texCoords, vertexColor, vertexColorFloats,
                        trianglesIndices1, unkIndices1, trianglesIndices2, unkIndices2, name
                    });
                }
                this.szme = new Szme(s, this.instanceCount, i0);
            } else if (this.type == 3) {
                let p0Count = s.u8();
                s.skip(p0Count * (4 + 4));

                let p3Count = s.u16();
                for (let i = 0; i < p3Count; ++i) {
                    let p4 = s.u16();
                    let p5Count = s.u8();
                    let p6Count = s.u8();
                    s.skip(p6Count * 3 * 4);

                    if (p0Count > 0) {
                        s.skip(4);

                        let p0CountN = p0Count;
                        if (p0Count > 3)
                            p0CountN = 4;

                        s.skip(p0CountN * p6Count);
                    }
                    s.skip(p5Count);

                    let p9Count = (p5Count + 0x1F) >> 5;
                    s.skip(p9Count * 4);
                }
            } else {
                throw `Unsupported type ${this.type}`;
            }

            for (let i = 0; i < this.instanceCount; ++i) {
                s.skip(1);

                if (i0 == 0)
                    s.skip(4);

                s.skip(2);

                let instanceMat = s.mat4();
                this.instances.push(instanceMat);

                s.skip(4 + 1);

                let k13 = new SzmeK13(s);
            }
        } else {
            s.skip(this.u0 * 2);
            let u2IgnCount = s.u32();
            s.skip(u2IgnCount);
        }
    }
}

class MeshContainer {
    public meshes: Mesh[] = [];
    public offset: number;

    public meshC2Entries: MeshC2Entry[] = [];

    constructor(s: DataStream, public containerIndex: number) {
        this.offset = s.offs;

        const c2Count = s.u16();
        for (let i = 0; i < c2Count; ++i) {
            const c3 = s.u16();
            const c4 = s.u16();
            const c5 = s.u32();
            const flags = s.u8();

            if ((flags & 0x1) == 0) {
                if ((flags & 0x2) != 0) {
                    s.skip(4 + 4);
                }
            } else {
                s.skip(4);
            }
            if ((flags & 0x4) != 0) {
                s.skip(1);
            }
            if ((flags & 0x8) != 0) {
                s.skip(1 + 4 + 3 * 4 * 4 + 1 + 1 + 4);
            }
            if ((flags & 0x10) != 0) {
                s.skip(1 + 4 + 4);
            }
            if ((flags & 0x20) != 0) {
                s.skip(3 * 4);
            }
            let transformMatrix: (mat4 | null) = null;
            if (c4 < 0x10) {
                let uVar8 = 1 << (c4 & 0x7F);
                if ((uVar8 & 0xA001) == 0) {
                    if ((uVar8 & 0x4100) == 0) {
                        transformMatrix = s.mat4();
                    } else {
                        s.skip(2);
                    }
                } else {
                    transformMatrix = s.mat4();
                }
            } else {
                transformMatrix = s.mat4();
            }
            this.meshC2Entries.push({ transformMatrix });
        }

        const caCount = s.u8();
        const caSize = 2 + 2 + 2 + 3 * 4 + 2 + 3 * 4;
        s.skip(caCount * caSize);

        const cbCount = s.u8();
        const cbSize = 2 + 2 + 1 + 1;
        s.skip(cbCount * cbSize);

        const ccCount = s.u8();
        for (let i = 0; i < ccCount; ++i) {
            s.skip(1 + 4 + 4 + 4 + 4 + 3 * 4 + 3 * 4);
            const cc7Count = s.u8();
            s.skip(cc7Count * 2);
        }

        s.skip(2 + 2 + 2 + 4);

        const i0 = s.u8();
        const i1 = s.vec3();
        const i2 = s.f32();
        const i3Count = s.u8();
        s.skip(i3Count * (2 + 0x20));
        s.skip(1);

        const meshCount = s.u16();
        // console.log(`meshCount: ${meshCount}`);
        let meshIndex = 0;
        while (meshIndex < meshCount) {
            const mesh = new Mesh(s, this, meshIndex, i0);

            if (mesh.u0 == 0)
                meshIndex += mesh.instanceCount;
            else
                meshIndex--;

            meshIndex++;
            this.meshes.push(mesh);
        }

        // TODO: mesh_data_unk3
        // TODO: c6Count, c9, etc
    }
}

class TextureClut {
    public h1: number; // if != 1, data is 'inline'. rare

    public data: ArrayBufferSlice;
    public dataOffset: number;

    public entryCount: number;
    public formatSize: number;

    constructor(s: DataStream) {
        s.skip(4);
        this.h1 = s.u8(); // if != 1, data is 'inline'. rare
        const h2Count = s.u8();
        s.skip(1 + 1);
        this.entryCount = s.u16();
        this.formatSize = s.u8();
        s.skip(1);
        this.dataOffset = s.u32();
        s.skip(h2Count * 2);
        if (this.h1 != 1 && this.entryCount > 0)
            this.data = s.buf(this.entryCount * this.formatSize);
    }
}

class TextureImage {
    public h1: number; // if != 1, data is 'inline'. rare

    public data: ArrayBufferSlice;
    public dataOffset: number;

    public dataSize: number;

    public width: number;
    public height: number;

    constructor(s: DataStream) {
        s.skip(4);
        this.h1 = s.u8();
        const h2Count = s.u8();
        s.skip(1 + 1);
        this.width = s.u16();
        this.height = s.u16();
        s.skip(1 + 1 + 2)
        this.dataSize = s.u32();
        this.dataOffset = s.u32();
        s.skip(h2Count * 2);
        if (this.h1 != 1 && this.dataSize > 0)
            this.data = s.buf(this.dataSize);
    }
}

class TextureIndices {
    public clutIndices: number[] = [];
    public imageIndices: number[] = [];

    constructor(s: DataStream) {
        s.skip(4 + 2);
        const imageIndicesCount = s.u8();
        const clutIndicesCount = s.u8();
        for (let i = 0; i < imageIndicesCount; ++i)
            this.imageIndices.push(s.u16());
        for (let i = 0; i < clutIndicesCount; ++i)
            this.clutIndices.push(s.u16());
    }
}

class TextureDesc {
    public indices: TextureIndices[] = [];

    constructor(s: DataStream) {
        s.skip(0x17);
        const innerCount = s.u8();
        s.skip(2);
        for (let i = 0; i < innerCount; i++)
            this.indices.push(new TextureIndices(s));
    }
}

class TextureContainer {
    public cluts: TextureClut[] = [];
    public images: TextureImage[] = [];
    public textureDescs: TextureDesc[] = [];

    constructor(s: DataStream, dataSize: number) {
        const clutCount = s.u16();
        for (let i = 0; i < clutCount; ++i)
            this.cluts.push(new TextureClut(s));

        const imageCount = s.u16();
        for (let i = 0; i < imageCount; ++i)
            this.images.push(new TextureImage(s));

        const i3Count = s.u16();
        s.skip(i3Count * (2 + 0x20));

        const textureDescCount = s.u16();
        for (let i = 0; i < textureDescCount; ++i)
            this.textureDescs.push(new TextureDesc(s));

        // console.log(`[${hexzero(s.offs)}] ${clutCount} ${imageCount}`);

        s.align(0x10);
        const data = s.buf(dataSize);

        for (let clut of this.cluts)
            if (clut.h1 == 1)
                clut.data = data.slice(clut.dataOffset, clut.dataOffset + clut.entryCount * clut.formatSize);

        for (let image of this.images)
            if (image.h1 == 1)
                image.data = data.slice(image.dataOffset, image.dataOffset + image.dataSize);
    }
}

class LevelObject {
    public offset: number;
    public header: ObjectEntry;
    public meshContainers: MeshContainer[] = [];
    public textureContainer: TextureContainer;
    public texturesDiffuse: Texture[] = [];
    public texturesUnk: Texture[] = [];
}

class DynamicObjectInstance {
    public objId0: number;
    public matrix: mat4;

    constructor(s: DataStream) {
        this.objId0 = s.u32();
        s.skip(1 + 2);
        this.matrix = s.mat4();
    }
}

// function parseObject(stream: DataStream, scriptOffsets: (number[] | null)): Object {
// }

// TODO: instances for other objects

// TODO: move elsewhere
export const SCRIPTS_EXPORT = false;
export const TEXTURES_EXPORT = false;
export const MESH_EXPORT = false;
export const MESH_EXPORT_GLTF = true;
export const MESH_SEPARATE_TO_OBJECTS = true;
export const MESH_SEPARATE_OBJECT_CHUNKS = true;
export const MESH_EXPORT_MATERIALS = true;
export const MESH_SCALE = 1 / 100.0;
export const LOG_OFFSETS_FOR_010_EDITOR = true;

class Sly2LevelSceneDesc implements SceneDesc {
    private objectOffsets: number[];
    private textureDescOffsets: number[];
    private scriptOffsets: number[];
    private meshcontOffsets: number[];
    private dynObjInstOffsets: number[];

    constructor(
        public id: string,
        public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const offsetsBin = await context.dataFetcher.fetchData(`${pathBase}/sly2-${this.id}-offsets.bin`)
        let offsetsStream = new DataStream(offsetsBin);

        let deserializeArray = (s: DataStream): number[] => {
            let len = s.u32();
            let arr: number[] = [];
            for (let i = 0; i < len; ++i)
                arr.push(s.u32());
            return arr;
        };
        this.objectOffsets = deserializeArray(offsetsStream);
        this.textureDescOffsets = deserializeArray(offsetsStream);
        this.scriptOffsets = deserializeArray(offsetsStream);
        this.meshcontOffsets = deserializeArray(offsetsStream);
        this.dynObjInstOffsets = deserializeArray(offsetsStream);

        let logArrayHex = (arr: number[], name: string = "") => {
            let msg = "";
            if (LOG_OFFSETS_FOR_010_EDITOR) {
                msg = `local int ${name}[${arr.length}] = {`;
                for (let v of arr) {
                    msg += `${hexzero0x(v, 4)},`;
                }
                msg = msg.slice(0, -1);
                msg += '};';
            } else {
                msg = `${name}: `;
                for (let v of arr) {
                    msg += `${hexzero(v, 8)} `;
                }
            }
            console.log(msg);
        };

        // logArrayHex(this.objectOffsets, "objectOffsets");
        // logArrayHex(this.textureDescOffsets, "textureDescOffsets");
        // logArrayHex(this.scriptOffsets, "scriptOffsets");
        // logArrayHex(this.meshcontOffsets, "meshcontOffsets");
        // logArrayHex(this.dynObjInstOffsets, "dynObjInstOffsets");

        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.slyZ.dec`)
        let s = new DataStream(bin);

        console.log(`loaded ${pathBase}/${this.id} of size ${bin.byteLength}`);

        const objectEntries = parseObjectEntries(s);
        console.log(objectEntries);

        // TODO: refactor to func

        let scriptFileEntries: ZipFileEntry[] = [];

        let scriptIndex = 0;
        let textureIndex = 0;
        let meshContIndex = 0;

        let objects: LevelObject[] = [];

        for (let i = 0; i < objectEntries.length; ++i) {
            let objectEntry = objectEntries[i];
            let objectOffset = this.objectOffsets[i];

            s.offs = objectOffset;

            let textureSize = s.u32();
            s.skip(4);
            let hasScripts = (s.u32() != 0);

            if (SCRIPTS_EXPORT && hasScripts) {
                while (scriptIndex < this.scriptOffsets.length) {
                    let scriptOffset = this.scriptOffsets[scriptIndex];

                    if (i >= objectEntries.length || scriptOffset > this.objectOffsets[i + 1])
                        break;

                    s.offs = scriptOffset;
                    let str0 = s.readString(s.u16());
                    let str1 = s.readString(s.u16());
                    let str2 = s.readString(s.u16());

                    if (str1 !== "")
                        console.info(`non0 str1: ${str1}`);

                    let filename = `${objectEntry.name}/${str0.replace(/\|/g, ",")}.scm`;
                    let data = new ArrayBufferSlice(enc.encode(str2).buffer);

                    scriptFileEntries.push({ filename, data });

                    ++scriptIndex;
                }
            }

            let object = new LevelObject();
            object.header = objectEntry;
            object.offset = objectOffset;

            let objLog = `${leftPad(objectEntry.name, 32, ' ')} #${leftPad(`${objectEntry.count}`, 2)} | TEX `;
            let hasTex = false;
            while (textureIndex < this.textureDescOffsets.length) {
                let textureDescOffset = this.textureDescOffsets[textureIndex];

                if (i >= objectEntries.length || textureDescOffset > this.objectOffsets[i + 1])
                    break;

                s.offs = textureDescOffset;
                object.textureContainer = new TextureContainer(s, textureSize);

                objLog += `${hexzero(textureDescOffset)}, `
                hasTex = true;

                ++textureIndex;
            }
            if (hasTex)
                objLog = objLog.substring(0, objLog.length - 2);

            objLog += ` | MESH `;
            let hasMeshcont = false;
            while (meshContIndex < this.meshcontOffsets.length) {
                let meshcontOffset = this.meshcontOffsets[meshContIndex];

                if (i >= objectEntries.length || meshcontOffset > this.objectOffsets[i + 1])
                    break;

                s.offs = meshcontOffset;
                try {
                    let meshContainer = new MeshContainer(s, meshContIndex)
                    object.meshContainers.push(meshContainer);
                    objLog += `[`;
                    for (let mesh of meshContainer.meshes)
                        objLog += `${mesh.type},`;
                    if (meshContainer.meshes.length > 0)
                        objLog = objLog.substring(0, objLog.length - 1);
                    objLog += `]${hexzero(meshcontOffset)}, `
                } catch (error) {
                    console.error(`obj \'${objectEntry.name}\' mcont @ ${hexzero0x(meshcontOffset)} id ${meshContIndex}: ${error}`);
                }

                hasMeshcont = true;

                ++meshContIndex;
            }
            if (hasMeshcont)
                objLog = objLog.substring(0, objLog.length - 2);

            console.log(objLog);

            objects.push(object);
        }

        let dynObjectInsts: DynamicObjectInstance[] = [];

        for (let dynObjOffs of this.dynObjInstOffsets) {
            s.offs = dynObjOffs;

            let dynObj = new DynamicObjectInstance(s);
            dynObjectInsts.push(dynObj);
        }

        if (SCRIPTS_EXPORT) {
            const zipFile = makeZipFile(scriptFileEntries);
            downloadBuffer(`${this.id}_scripts.zip`, zipFile);
        }

        for (let object of objects) {
            let texEntryIdx = 0;
            const texCont = object.textureContainer;
            let descIdx = 0;
            for (let desc of texCont.textureDescs) {
                for (let indices of desc.indices) {
                    enum TextureType {
                        Diffuse,
                        Unk
                    }

                    let makeTexture = (clutIndexIndex: number, imageIndexIndex: number, type: TextureType) => {
                        const clutIndex = indices.clutIndices[clutIndexIndex];
                        const imageIndex = indices.imageIndices[imageIndexIndex];

                        if (clutIndex >= texCont.cluts.length) {
                            console.warn(`warn: [id ${texEntryIdx}] clutIndex (${clutIndex}) out of bounds, skipping`);
                            return;
                        }
                        if (imageIndex >= texCont.images.length) {
                            console.warn(`warn: [id ${texEntryIdx}] imageIndex (${imageIndex}) out of bounds, skipping`);
                            return;
                        }
                        const clutMeta = texCont.cluts[clutIndex];
                        const imageMeta = texCont.images[imageIndex];

                        const width = imageMeta.width;
                        const height = imageMeta.height;
                        // console.log(`clutMeta: ${clutMeta.offset} imageMeta: ${imageMeta.offset}`);
                        // console.log(`w: ${width} h: ${height} C: ${hexzero(clutMeta.offset, 8)} I: ${hexzero(imageMeta.offset, 8)}`);

                        let typeStr = '';
                        switch (type) {
                            case TextureType.Diffuse: typeStr = 'Dif'; break;
                            case TextureType.Unk: typeStr = 'Unk'; break;
                        }

                        const name = sprintf(`%d_%s %03d-%02d-%02d-%02d %03d-%03d Res %04dx%04d Clt %05X Img %06X Cols %03d T %s`,
                            object.header.index, object.header.name, texEntryIdx, descIdx, clutIndexIndex, imageIndexIndex, clutIndex, imageIndex, width, height,
                            clutMeta.dataOffset, imageMeta.dataOffset, clutMeta.entryCount, typeStr);
                        console.info(name);
                        // console.log(`pal ${hexzero(clutMeta.data.byteLength)} ${hexzero(clutMeta.dataOffset)} img ${hexzero(imageMeta.data.byteLength)} ${hexzero(imageMeta.dataOffset)}`);

                        const paletteBuf = clutMeta.data;
                        const imageBuf = imageMeta.data;

                        const texture = new Texture(texEntryIdx, paletteBuf, imageBuf, width, height, clutMeta.entryCount, clutMeta.formatSize, name);
                        switch (type) {
                            case TextureType.Diffuse:
                                object.texturesDiffuse.push(texture);
                                break;
                            case TextureType.Unk:
                                object.texturesUnk.push(texture);
                                break;
                        }
                    };

                    const clutCount = indices.clutIndices.length;
                    const imageCount = indices.imageIndices.length;

                    const isNImgNPal = (clutCount == imageCount);
                    const is1Img1Pal = (clutCount == 1 && imageCount == 1);
                    const is1ImgNPal = (imageCount == 1 && clutCount > 1);
                    const isNImgMPal = (!isNImgNPal && clutCount > 1 && imageCount > 1);
                    const isPalDoubleImg = (clutCount == imageCount * 2);
                    const isPalTripleImg = (clutCount == imageCount * 3);

                    if (is1Img1Pal) {
                        console.log(`1ImgMPal: ${texEntryIdx} ${clutCount} ${imageCount}`);
                        makeTexture(0, 0, TextureType.Diffuse);
                    } else if (is1ImgNPal) {
                        console.log(`1ImgMPal: ${texEntryIdx} ${clutCount} ${imageCount}`);
                        for (let clutIndexIndex = 0; clutIndexIndex < indices.clutIndices.length; ++clutIndexIndex) {
                            const type = clutIndexIndex == 0 ? TextureType.Diffuse : TextureType.Unk;
                            makeTexture(clutIndexIndex, 0, type);
                        }
                    } else if (isNImgMPal) {
                        console.error(`NImgMPal: ${texEntryIdx} ${clutCount} ${imageCount}`);
                        if (!Number.isInteger(clutCount / imageCount)) {
                            console.warn(`NImgMPal: nonint ${texEntryIdx} ${clutCount} ${imageCount}`);
                            makeTexture(0, 0, TextureType.Diffuse);
                            continue;
                        }
                        const ratio = clutCount / imageCount;
                        for (let i = 0; i < clutCount; ++i) {
                            const type = i == 0 ? TextureType.Diffuse : TextureType.Unk;
                            makeTexture(i, Math.floor(i / ratio), type);
                        }
                    }

                    descIdx++;
                }
                texEntryIdx++;
            }
        }

        if (TEXTURES_EXPORT) {
            let zipFileEntries: ZipFileEntry[] = [];

            const dumpTextures = async (textures: (Texture | null)[]) => {
                await Promise.all(textures.filter((texture) => texture !== null).map(async (texture) => {
                    const surface = texture!.toCanvas().surfaces[0];
                    const blob: (Blob | null) = await new Promise((resolve, reject) => {
                        surface.toBlob((blob: Blob | null) => blob !== null ? resolve(blob) : reject(null));
                    });
                    if (blob) {
                        const data = await blob.arrayBuffer();
                        zipFileEntries.push({ filename: texture!.name + '.png', data: new ArrayBufferSlice(data) });
                    }
                }));
            };

            for (let object of objects) {
                await dumpTextures(object.texturesDiffuse);
                await dumpTextures(object.texturesUnk);
            }

            console.log(zipFileEntries);

            const zipFile = makeZipFile(zipFileEntries);
            downloadBuffer(`${this.id}_textures.zip`, zipFile);
        }

        if (MESH_EXPORT) {
            let obj_str = "";
            if (MESH_EXPORT_MATERIALS)
                obj_str += `mtllib ${this.id}.mtl\n`;

            obj_str += `g all\n`;
            obj_str += `s off\n`;

            let face_idx_base = 1;

            let chunkTotalIdx = 0;
            for (let object of objects) {
                // if (object.header.index == 286)
                //     continue;

                for (let meshContainer of object.meshContainers) {
                    let meshIdx = 0;

                    for (let mesh of meshContainer.meshes) {
                        if (MESH_SEPARATE_TO_OBJECTS && !MESH_SEPARATE_OBJECT_CHUNKS)
                            obj_str += `o ${mesh.container.containerIndex}_[${object.header.index}]${object.header.name}_${mesh.meshIndex}_${chunkTotalIdx}_T${mesh.type}_${hexzero(mesh.offset)}\n`;

                        let meshInstanceMatrices = [mat4.create()];

                        for (let meshInstance of mesh.instances)
                            meshInstanceMatrices.push(mat4.clone(meshInstance));

                        // TODO: This is slow!
                        let dynObjects: mat4[] = [];
                        for (let dynObjInst of dynObjectInsts) {
                            if (object.header.id0 == dynObjInst.objId0) {
                                dynObjects.push(dynObjInst.matrix);
                            }
                        }
                        for (let dynObjInstance of dynObjects)
                            meshInstanceMatrices.push(mat4.clone(dynObjInstance));

                        if (mesh.u0 == 0) {
                            let transformC2 = meshContainer.meshC2Entries[mesh.containerInstanceMatrixIndex].transformMatrix;

                            if (transformC2) {
                                for (let i = 0; i < meshInstanceMatrices.length; ++i) {
                                    // TODO: change order?
                                    mat4.multiply(meshInstanceMatrices[i], meshInstanceMatrices[i], transformC2!);
                                }
                            }
                        }

                        let instanceIdx = 0;
                        for (let meshInstanceMatrix of meshInstanceMatrices) {
                            let chunkIdx = 0;
                            for (let chunk of mesh.chunks) {
                                if (MESH_SEPARATE_TO_OBJECTS && MESH_SEPARATE_OBJECT_CHUNKS)
                                    obj_str += `o ${mesh.container.containerIndex}_[${object.header.index}]${object.header.name}_${mesh.meshIndex}_${chunkIdx}_${instanceIdx}_${chunkTotalIdx}_${hexzero(mesh.offset)}\n`;

                                let newPos = vec3.create();

                                for (let i = 0; i < chunk.positions.length; i += 3) {
                                    const pos = vec3.fromValues(chunk.positions[i + 0], chunk.positions[i + 1], chunk.positions[i + 2]);

                                    vec3.transformMat4(newPos, pos, meshInstanceMatrix);

                                    let scaledPos = vec3.fromValues(
                                        newPos[0] * MESH_SCALE,
                                        newPos[1] * MESH_SCALE,
                                        newPos[2] * MESH_SCALE);

                                    obj_str += `v ${scaledPos[0]} ${scaledPos[1]} ${scaledPos[2]}\n`;
                                }

                                for (let i = 0; i < chunk.normals.length; i += 3) {
                                    let normal = vec3.fromValues(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);

                                    obj_str += `vn ${normal[0]} ${normal[1]} ${normal[2]}\n`;
                                }

                                for (let i = 0; i < chunk.texCoords.length; i += 2) {
                                    const texCoord = vec2.fromValues(chunk.texCoords[i], chunk.texCoords[i + 1]);

                                    obj_str += `vt ${texCoord[0]} ${texCoord[1]}\n`;
                                }
                                const szme = mesh.szme.chunks[chunkIdx];

                                if (MESH_EXPORT_MATERIALS) {
                                    obj_str += `usemtl ${object.header.index}_${szme!.textureId0}\n`
                                }

                                for (let i = 0; i < chunk.trianglesIndices1.length; i += 3) {
                                    const f0 = face_idx_base + chunk.trianglesIndices1[i + 0];
                                    const f1 = face_idx_base + chunk.trianglesIndices1[i + 1];
                                    const f2 = face_idx_base + chunk.trianglesIndices1[i + 2];

                                    obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
                                }

                                if (MESH_EXPORT_MATERIALS) {
                                    obj_str += `usemtl ${object.header.index}_${szme!.textureId1}\n`
                                }

                                for (let i = 0; i < chunk.trianglesIndices2.length; i += 3) {
                                    const f0 = face_idx_base + chunk.trianglesIndices2[i + 0];
                                    const f1 = face_idx_base + chunk.trianglesIndices2[i + 1];
                                    const f2 = face_idx_base + chunk.trianglesIndices2[i + 2];

                                    obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
                                }
                                face_idx_base += chunk.positions.length / 3;

                                chunkIdx++;
                                chunkTotalIdx++;
                            }
                            instanceIdx++;
                        }
                        meshIdx++;
                    }
                }
            }

            downloadText(`${this.id}.obj`, obj_str);

            if (MESH_EXPORT_MATERIALS) {
                let mat_str = 'newmtl empty\n';

                for (let object of objects) {
                    for (let texture of object.texturesDiffuse) {
                        mat_str += `newmtl ${object.header.index}_${texture.texEntryIdx}\n`;

                        const texFilename = `${this.id}_textures/${texture.name}.png`;
                        mat_str += `map_Kd ${texFilename}\n`;
                        if (!texture.isFullyOpaque)
                            mat_str += `map_d ${texFilename}\n`;
                    }
                }

                downloadText(`${this.id}.mtl`, mat_str);
            }
        }

        const renderer = new Sly2Renderer(device);
        return renderer;
    }
}

// From https://docs.google.com/spreadsheets/d/1bdhTl2IvXVWOjnjhpgUTH0kg6e-RcioezIYrsi-_mso/edit#gid=0
// TODO: Should titles be world titles instead of ep?
const sceneDescs = [
    "Main Hubs",
    new Sly2LevelSceneDesc("jb_intro", "P. A Shadow from the Past (Cairo, Egypt)"),
    new Sly2LevelSceneDesc("f_nightclub_exterior", "1. The Black Chateau (Paris, France)"),
    new Sly2LevelSceneDesc("i_palace_ext", "2. A Starry Eyed Encounter (Rajan's palace, India)"),
    new Sly2LevelSceneDesc("i_temple_ext", "3. The Predator Awakes (Spice temple, India)"),
    new Sly2LevelSceneDesc("p_prison_ext", "4. Jailbreak (The Contessa's prison, Prague)"),
    new Sly2LevelSceneDesc("p_castle_ext", "5. A Tangled Web (Contessa's castle, Prague)"),
    new Sly2LevelSceneDesc("c_train_ext", "6. He Who Tames the Iron Horse (Nunavut Bay, Canada)"),
    new Sly2LevelSceneDesc("c_sawmill_ext", "7. Menace from the North, eh! (Lumber camp, Canada)"),
    new Sly2LevelSceneDesc("a_blimp_ext", "8. Anatomy for Disaster (Arpeggio's blimp)"),
    "Other",
    new Sly2LevelSceneDesc("dvd_menu", "dvd_menu"),
];

const id = 'Sly2';
const name = 'Sly 2: Band of Thieves';
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
