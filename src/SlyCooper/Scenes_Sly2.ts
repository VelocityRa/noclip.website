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
import * as Data from './SlyData';
import { DataStream } from "./DataStream";
import { sprintf } from "./sprintf";

const pathBase = `Sly2`;

// Research at: https://github.com/VelocityRa/SlyTools/blob/main/templates/sly2_ps3_meshes.bt

let enc = new TextEncoder();

// TODO: move to other file
interface ObjectEntry {
    name: string;
    type: string; // char
    count: number;
}
function parseObjectEntries(s: DataStream): ObjectEntry[] {
    let objects: ObjectEntry[] = [];

    let objectCount = s.u16();
    for (let i = 0; i < objectCount; ++i) {
        let resourceDescriptorStr = s.readString(0x40);
        let type = resourceDescriptorStr[3];
        let name = resourceDescriptorStr.substr(4);

        s.skip(4 * 4);

        let count = s.u32();

        objects.push({ name, type, count });
    }

    return objects;
}

class SzmeK13 {
    constructor(s: DataStream) {
        let k0Count = s.u16();
        if (k0Count > 0) {
            for (let i = 0; i < k0Count; i++) {
                let k11Count = s.u16();
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
    constructor(s: DataStream, flags: number, instanceCount: number, e2Count: number, i0: number) {
        let a0Count = s.u8();

        let a0UnkCount = 0;

        for (let i = 0; i < a0Count; ++i) {
            let a0x = s.u32();
            s.skip(4 + 4);
            a0UnkCount += a0x;
        }

        let vertexCount = s.u8();
        s.skip(vertexCount * 3 * 4); // positions
        s.skip(vertexCount * 2 * 4); // texcoords
        s.skip(vertexCount * 3 * 4); // normals
        s.skip(vertexCount * 4);     // unk (a4)

        s.skip(1);

        if (e2Count > 0) {
            s.skip(4);

            let e2CountMin = Math.min(e2Count, 4);
            s.skip(vertexCount * e2CountMin);
        }

        s.skip(a0UnkCount);

        let uVar28 = a0UnkCount + 0x1F;
        let uVar29 = (uVar28 < 0 && (uVar28 & 0x1f) != 0) ? 1 : 0;
        let a6UintCount = (uVar28 >> 5) + uVar29;

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

        let e2Count = s.u8();
        s.skip(e2Count * (4 + 2));

        let e3 = s.u8();
        if (e3 != 0xFF) {
            let e4 = s.vec3();
            let e5 = s.vec2();
            let e6 = s.vec3();
        }

        let k13 = new SzmeK13(s);

        if ((this.flags & 0x4) != 0) {
            let e7 = s.u32();
            let e8 = s.u8();

            if (e8 != 0xFF) {
                s.skip(4 + 4 + 4 + 4 + 3 * 4 * 4);
            }

            s.skip(1 + 1 + 1);
        }

        let szmeDataCount = s.u16();
        for (let i = 0; i < szmeDataCount; ++i) {
            let szmeChunk = new SzmeChunk(s, this.flags, instanceCount, e2Count, i0);
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

// TODO: is u6 & g4 texture ID?

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

    constructor(s: DataStream, public readonly container: MeshContainer, public meshIndex: number, i0: number) {
        this.offset = s.offs;

        this.u0 = s.u8();

        if (this.u0 == 0) {
            this.type = s.u8();
            this.instanceCount = s.u16();
            s.skip(2 + 1);
            let u4 = s.f32();
            let u5 = s.f32();
            let u6 = s.u32();
            s.skip(1 + 1);

            if (i0 == 0) {
                let u9 = s.vec3();
                let u10 = s.f32();
                let u11 = s.u32();
                let u12 = s.f32();
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
                    let trianglesIndices1 = new Uint16Array(triangleCount1);
                    for (let i = 0; i < triangleCount1; ++i) {
                        trianglesIndices1[i] = s.u16();
                    }
                    // Read index data 1
                    s.offs = startOffs + indexDataOffset1;
                    let unkIndices1 = new Uint16Array(indexCount1);
                    for (let i of range_end(0, indexCount1)) {
                        unkIndices1[i] = s.u16();
                    }
                    // Read triangle data 2
                    s.offs = startOffs + triangleDataOffset2;
                    let trianglesIndices2 = new Uint16Array(triangleCount2);
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

    constructor(s: DataStream, public containerIndex: number) {
        this.offset = s.offs;

        // debugger;

        let c2Count = s.u16();
        for (let i = 0; i < c2Count; ++i) {
            let c3 = s.u16();
            let c4 = s.u16();
            let c5 = s.u32();
            let flags = s.u8();

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
            if (c4 < 0x10) {
                let uVar8 = 1 << (c4 & 0x7F);
                if ((uVar8 & 0xA001) == 0) {
                    if ((uVar8 & 0x4100) == 0) {
                        s.skip(3 * 4 * 4);
                    } else {
                        s.skip(2);
                    }
                } else {
                    s.skip(3 * 4 * 4);
                }
            } else {
                s.skip(3 * 4 * 4);
            }
        }

        let caCount = s.u8();
        const caSize = 2 + 2 + 2 + 3 * 4 + 2 + 3 * 4;
        s.skip(caCount * caSize);

        let cbCount = s.u8();
        const cbSize = 2 + 2 + 1 + 1;
        s.skip(cbCount * cbSize);

        let ccCount = s.u8();
        for (let i = 0; i < ccCount; ++i) {
            s.skip(1 + 4 + 4 + 4 + 4 + 3 * 4 + 3 * 4);
            let cc7Count = s.u8();
            s.skip(cc7Count * 2);
        }

        s.skip(2 + 2 + 2 + 4);

        let i0 = s.u8();
        let i1 = s.vec3();
        let i2 = s.f32();
        let i3Count = s.u8();
        s.skip(i3Count * (2 + 0x20));
        s.skip(1);

        let meshCount = s.u16();
        console.log(`meshCount: ${meshCount}`);
        let meshIndex = 0;
        while (meshIndex < meshCount) {
            let mesh = new Mesh(s, this, meshIndex, i0);

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
    public data: ArrayBufferSlice;
    public dataOffset: number;

    constructor(s: DataStream) {
        s.skip(4);
        let h1 = s.u8(); // if != 1, data is 'inline'. rare
        let h2Count = s.u8();
        s.skip(1 + 1);
        let inlineDataSize = s.u16();
        let formatSize = s.u8();
        s.skip(1);
        this.dataOffset = s.u32();
        s.skip(h2Count * 2);
        if (h1 != 1 && inlineDataSize > 0)
            this.data = s.buf(inlineDataSize * formatSize);
    }
}

class TextureImage {
    public data: ArrayBufferSlice;
    public dataOffset: number;
    public width: number;
    public height: number;

    constructor(s: DataStream) {
        s.skip(4);
        let h1 = s.u8(); // if != 1, data is 'inline'. rare
        let h2Count = s.u8();
        s.skip(1 + 1);
        this.width = s.u16();
        this.height = s.u16();
        s.skip(1 + 1 + 2)
        let inlineDataSize = s.u32();
        this.dataOffset = s.u32();
        s.skip(h2Count * 2);
        if (h1 != 1 && inlineDataSize > 0)
            this.data = s.buf(inlineDataSize);
    }
}

class TextureIndices {
    public clutIndices: number[] = [];
    public imageIndices: number[] = [];

    constructor(s: DataStream) {
        s.skip(4 + 2);
        let imageIndicesCount = s.u8();
        let clutIndicesCount = s.u8();
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
        let innerCount = s.u8();
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
        let clutCount = s.u16();
        if (clutCount == 0x49) debugger;
        for (let i = 0; i < clutCount; ++i)
            this.cluts.push(new TextureClut(s));

        let imageCount = s.u16();
        for (let i = 0; i < imageCount; ++i)
            this.images.push(new TextureImage(s));

        let i3Count = s.u16();
        s.skip(i3Count * (2 + 0x20));

        let textureDescCount = s.u16();
        for (let i = 0; i < textureDescCount; ++i)
            this.textureDescs.push(new TextureDesc(s));

        s.align(0x10);
        const data = s.buf(dataSize);

        // todo consolidate
        console.log(`[${hexzero(s.offs)}] ${clutCount} ${imageCount}`);

    }
}

class LevelObject {
    public offset: number;
    public header: ObjectEntry;
    public meshContainers: MeshContainer[] = [];
    public textureContainer: TextureContainer;
}

// function parseObject(stream: DataStream, scriptOffsets: (number[] | null)): Object {
// }

// TODO: move elsewhere
export const SCRIPTS_EXPORT = false;
export const MESH_EXPORT = true;
export const SEPARATE_OBJECT_SUBMESHES = true;
export const MESH_SCALE = 1 / 1000.0;

class Sly2LevelSceneDesc implements SceneDesc {
    constructor(
        public id: string,
        public name: string,
        private objectOffsets: number[],
        private textureDescOffsets: number[],
        private scriptOffsets: number[],
        private meshcontOffsets: number[]) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.slyZ.dec`)
        let s = new DataStream(bin);

        console.log(`loaded ${pathBase}/${this.id} of size ${bin.byteLength}`);

        let objectEntries = parseObjectEntries(s);
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

            let obj_log = `${leftPad(objectEntry.name, 32, ' ')} #${leftPad(`${objectEntry.count}`, 2)} | TEX `;
            let hasTex = false;
            while (textureIndex < this.textureDescOffsets.length) {
                let textureDescOffset = this.textureDescOffsets[textureIndex];

                if (i >= objectEntries.length || textureDescOffset > this.objectOffsets[i + 1])
                    break;

                s.offs = textureDescOffset;
                object.textureContainer = new TextureContainer(s, textureSize);

                obj_log += `${hexzero(textureDescOffset)}, `
                hasTex = true;

                ++textureIndex;
            }
            if (hasTex)
                obj_log = obj_log.substring(0, obj_log.length - 2);

            obj_log += ` | MESH `;
            let hasMeshcont = false;
            while (meshContIndex < this.meshcontOffsets.length) {
                let meshcontOffset = this.meshcontOffsets[meshContIndex];

                if (i >= objectEntries.length || meshcontOffset > this.objectOffsets[i + 1])
                    break;

                s.offs = meshcontOffset;
                try {
                    let meshContainer = new MeshContainer(s, meshContIndex)
                    object.meshContainers.push(meshContainer);
                } catch (error) {
                    console.error(`obj \'${objectEntry.name}\' mcont @ ${hexzero0x(meshcontOffset)} id ${meshContIndex}: ${error}`);
                }

                obj_log += `${hexzero(meshcontOffset)}, `
                hasMeshcont = true;

                ++meshContIndex;
            }
            if (hasMeshcont)
                obj_log = obj_log.substring(0, obj_log.length - 2);

            console.log(obj_log);

            objects.push(object);
        }

        if (SCRIPTS_EXPORT) {
            const zipFile = makeZipFile(scriptFileEntries);
            downloadBuffer(`${this.id}_scripts.zip`, zipFile);
        }

        if (MESH_EXPORT) {
            let obj_str = "";

            let face_idx_base = 1;

            let chunkTotalIdx = 0;
            for (let object of objects) {
                for (let meshContainer of object.meshContainers) {
                    let chunkIdx = 0;

                    for (let mesh of meshContainer.meshes) {
                        if (!SEPARATE_OBJECT_SUBMESHES)
                            obj_str += `o ${mesh.container.containerIndex}_${object.header.name}_${mesh.meshIndex}_${chunkTotalIdx}_T${mesh.type}_${hexzero(mesh.offset)}\n`;

                        let meshInstanceMatrices = [mat4.create()];

                        for (let meshInstance of mesh.instances)
                            meshInstanceMatrices.push(meshInstance);

                        let instanceIdx = 0;
                        for (let meshInstanceMatrix of meshInstanceMatrices) {
                            for (let chunk of mesh.chunks) {
                                if (SEPARATE_OBJECT_SUBMESHES)
                                    obj_str += `o ${mesh.container.containerIndex}_${object.header.name}_${mesh.meshIndex}_${chunkIdx}_${instanceIdx}_${chunkTotalIdx}_${hexzero(mesh.offset)}\n`;

                                if (instanceIdx == 0) {
                                    for (let i = 0; i < chunk.positions.length; i += 3) {
                                        const pos = vec3.fromValues(chunk.positions[i + 0], chunk.positions[i + 1], chunk.positions[i + 2]);

                                        let scaledPos = vec3.fromValues(
                                            pos[0] * MESH_SCALE,
                                            pos[1] * MESH_SCALE,
                                            pos[2] * MESH_SCALE);

                                        obj_str += `v ${scaledPos[0]} ${scaledPos[1]} ${scaledPos[2]}\n`;
                                    }
                                } else {
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
                                }

                                for (let i = 0; i < chunk.normals.length; i += 3) {
                                    let normal = vec3.fromValues(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);

                                    obj_str += `vn ${normal[0]} ${normal[1]} ${normal[2]}\n`;
                                }

                                for (let i = 0; i < chunk.texCoords.length; i += 2) {
                                    let texCoord = vec2.fromValues(chunk.texCoords[i], chunk.texCoords[i + 1]);

                                    obj_str += `vt ${texCoord[0]} ${texCoord[1]}\n`;
                                }

                                for (let i = 0; i < chunk.trianglesIndices1.length; i += 3) {
                                    const f0 = face_idx_base + chunk.trianglesIndices1[i + 0];
                                    const f1 = face_idx_base + chunk.trianglesIndices1[i + 1];
                                    const f2 = face_idx_base + chunk.trianglesIndices1[i + 2];

                                    obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
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
                    }
                }
            }

            downloadText(`${this.id}.obj`, obj_str);
        }

        const renderer = new Sly2Renderer(device);
        return renderer;
    }
}


// todo remove texdataoffs

let objectOffsets_f_nightclub_exterior = [0x0FD1A0, 0x0FD560, 0x10C420, 0x113EA0, 0x114C10, 0x116590, 0x117F10, 0x119900, 0x11B290, 0x13EA00, 0x140350, 0x141CF0, 0x159F50, 0x15ACD0, 0x15C670, 0x1629E0, 0x168C20, 0x1D6C80, 0x1ECD50, 0x1EE6F0, 0x1F3590, 0x1F4F00, 0x1F4F80, 0x20ECA0, 0x220EE0, 0x2242D0, 0x225C30, 0x2276E0, 0x23CFA0, 0x248880, 0x24A220, 0x24EBB0, 0x25D990, 0x26F8D0, 0x291490, 0x2A9EB0, 0x2EC060, 0x2EE4D0, 0x2F4720, 0x2F60C0, 0x2FEDA0, 0x314B50, 0x32A880, 0x394170, 0x3A3030, 0x3A3B30, 0x3A8200, 0x3AA360, 0x3AB090, 0x3B57F0, 0x3B6540, 0x42D320, 0x42ECB0, 0x430650, 0x43E870, 0x44DE30, 0x471CF0, 0x480990, 0x491880, 0x493230, 0x525B50, 0x526870, 0x5340F0, 0x535500, 0x592630, 0x596FB0, 0x59B930, 0x59D2E0, 0x5A9600, 0x5B3C10, 0x5C0070, 0x5CA750, 0x5CD970, 0x5CDBB0, 0x5CF520, 0x5D7500, 0x5DA550, 0x5E0820, 0x5E9260, 0x5F5580, 0x5F63B0, 0x6085F0, 0x608FE0, 0x62B250, 0x62CBE0, 0x6347F0, 0x636170, 0x639340, 0x63DCD0, 0x654750, 0x655CE0, 0x65BEE0, 0x65BF60, 0x662180, 0x6D4BD0, 0x6DAE30, 0x6DBB30, 0x6E96C0, 0x730CF0, 0x735660, 0x736FF0, 0x73A9B0, 0x751430, 0x75D750, 0x769A70, 0x803D50, 0x8072C0, 0x80CED0, 0x81B3A0, 0x8286A0, 0x83C8C0, 0x83DA50, 0x83E7C0, 0x83F560, 0x84BFE0, 0x84D990, 0x876800, 0x88AAE0, 0x895220, 0x8A9EE0, 0x8BA460, 0x8C4CF0, 0xA1DBE0, 0xA25740, 0xA2A4F0, 0xA32200, 0xA32F50, 0xA4E6A0, 0xA53E70, 0xA5B9E0, 0xA6CE90, 0xA73E40, 0xA79200, 0xA7C8A0, 0xA83AE0, 0xC87BF0, 0xC89590, 0xC8A2E0, 0xC8D4A0, 0xC8EE20, 0xC93780, 0xC95120, 0xC99AA0, 0xC9A810, 0xC9C170, 0xCA5F30, 0xCA7890, 0xCA85F0, 0xDA03A0, 0xDCFB60, 0xDD2E70, 0xDD6030, 0xDDA990, 0xE35320, 0xE775A0, 0xE7FB40, 0xE8AE20, 0xE8C790, 0xE8E100, 0xE8FA90, 0xE943F0, 0xE94470, 0xEA6E60, 0xEA8820, 0xEAA190, 0xEABB30, 0xEAD4D0, 0xEAE230, 0xEB0D40, 0xEB26E0, 0xEB7040, 0xEEBB50, 0xEF1AC0, 0xEF7D00, 0xEF9660, 0x10822F0, 0x1088550, 0x1089EE0, 0x108B850, 0x10A7740, 0x10A84C0, 0x10A9E60, 0x123EAD0, 0x1249C20, 0x125D750, 0x1267100, 0x1267AF0, 0x1268840, 0x12752C0, 0x1276C50, 0x12779C0, 0x12804C0, 0x1286730, 0x12CD030, 0x12D02C0, 0x12D1020, 0x12D80F0, 0x12EA330, 0x12F0560, 0x12FE5C0, 0x12FFF50, 0x13B8C00, 0x13C0770, 0x13C3920, 0x13CE700, 0x13D00C0, 0x13D0E40, 0x13D27D0, 0x13DEAF0, 0x13DF880, 0x13E05E0, 0x13ED060, 0x140C9A0, 0x14149A0, 0x1420CC0, 0x1421A10, 0x1439F00, 0x14403A0, 0x1441D30, 0x144DD10, 0x144F680, 0x14558E0, 0x1461BE0, 0x146DEE0, 0x146F870, 0x14705D0, 0x1471330, 0x1473A70, 0x1789E10, 0x17903A0, 0x17E14F0, 0x1845210, 0x1859990, 0x185E300, 0x1863BF0, 0x1865570, 0x1874F30, 0x1886960, 0x189C220, 0x18D4F50, 0x18D5CB0, 0x18D7620, 0x18D8FA0, 0x18D9D10, 0x18DB6A0, 0x18E0CB0, 0x1C13020, 0x1C13AA0, 0x1C15170, 0x1C448E0, 0x1C842B0, 0x1C8CBB0, 0x1C92CF0, 0x1CB65E0, 0x1CBAF50, 0x1CC11B0, 0x1CC2B50, 0x1CC8DB0, 0x1DDE2B0, 0x1F16D60, 0x1F186D0, 0x1F18750, 0x1F294A0, 0x1F2D150, 0x1F40BC0, 0x1F58C00, 0x1F5A5A0, 0x1F5A620, 0x1F5D870, 0x1F68F40, 0x1F7ACD0, 0x1F7C670, 0x1F7C6F0, 0x1F87D50, 0x1F93FE0, 0x1F973B0, 0x1FA3350, 0x1FAA9E0, 0x1FB22E0, 0x1FBD0A0, 0x1FC3680, 0x206C0F0, 0x206DA90, 0x2082520, 0x20825A0, 0x208F710, 0x208F830];
// scanstring: "LR=18F0A4,127288,027BD8"
let textureDescOffsets_f_nightclub_exterior = [0x0FD1B0, 0x0FE422, 0x10C430, 0x113EB0, 0x114C20, 0x1165A0, 0x117F20, 0x119910, 0x11C200, 0x13EA10, 0x140360, 0x141D00, 0x159F60, 0x15ACE0, 0x15C680, 0x1629F0, 0x168C30, 0x1D6C90, 0x1ECD60, 0x1EE700, 0x1F35A0, 0x1F4F10, 0x1F4F90, 0x20ECB0, 0x220EF0, 0x2242E0, 0x225C40, 0x2276F0, 0x23D1CE, 0x248890, 0x24A230, 0x24EBC0, 0x25D9A0, 0x26F8E0, 0x291990, 0x2A9EC0, 0x2EC070, 0x2EE4E0, 0x2F4730, 0x2F6A89, 0x2FFF25, 0x314B60, 0x32B3C2, 0x395030, 0x3A3040, 0x3A3B40, 0x3A8210, 0x3AA370, 0x3AB0A0, 0x3B5800, 0x3B683C, 0x42D330, 0x42ECC0, 0x430660, 0x43F72B, 0x44DE40, 0x471D00, 0x4809A0, 0x491890, 0x4DF1C9, 0x525B60, 0x526880, 0x534100, 0x535510, 0x592640, 0x596FC0, 0x59B940, 0x59D2F0, 0x5A9610, 0x5B3C20, 0x5C03A5, 0x5CA760, 0x5CD980, 0x5CDBC0, 0x5CF530, 0x5D7510, 0x5DA560, 0x5E0830, 0x5E9270, 0x5F635F, 0x5F63C0, 0x608600, 0x608FF0, 0x62B260, 0x62CBF0, 0x634800, 0x636180, 0x639350, 0x63DCE0, 0x654760, 0x655CF0, 0x65BEF0, 0x65BF70, 0x662190, 0x6D4BE0, 0x6DAE40, 0x6DBB40, 0x6E96D0, 0x730D00, 0x735670, 0x737F95, 0x73A9C0, 0x751440, 0x75D760, 0x76EDC0, 0x803D60, 0x8074F1, 0x80CEE0, 0x81B3B0, 0x8286B0, 0x83CD0E, 0x83DA60, 0x83E7D0, 0x83F570, 0x84BFF0, 0x84D9A0, 0x877A17, 0x88AAF0, 0x895230, 0x8AA1B3, 0x8BA470, 0x8CC0AF, 0xA1DBF0, 0xA25750, 0xA2A500, 0xA32210, 0xA33EBD, 0xA4E6B0, 0xA547F0, 0xA5B9F0, 0xA6CEA0, 0xA74170, 0xA7C810, 0xA7D172, 0xA924B7, 0xC87C00, 0xC895A0, 0xC8A2F0, 0xC8D4B0, 0xC8EE30, 0xC93790, 0xC95130, 0xC99AB0, 0xC9A820, 0xC9C180, 0xCA5F40, 0xCA78A0, 0xCAF39E, 0xDA03B0, 0xDCFB70, 0xDD2E80, 0xDD6040, 0xDDA9A0, 0xE35888, 0xE7800B, 0xE7FB50, 0xE8AE30, 0xE8C7A0, 0xE8E110, 0xE8FAA0, 0xE94400, 0xE94B4F, 0xEA6E70, 0xEA8830, 0xEAA1A0, 0xEABB40, 0xEAD4E0, 0xEAEBF4, 0xEB0D50, 0xEB26F0, 0xEBA919, 0xEEBB60, 0xEF1AD0, 0xEF7D10, 0xEFA51C, 0x1082300, 0x1088560, 0x1089EF0, 0x108C5F0, 0x10A7750, 0x10A84D0, 0x10AA915, 0x123F45B, 0x1249C30, 0x125D760, 0x1267110, 0x1267B00, 0x1268850, 0x12752D0, 0x1276C60, 0x127800D, 0x12804D0, 0x1286FE0, 0x12CD040, 0x12D02D0, 0x12D1030, 0x12D8100, 0x12EA340, 0x12F08C2, 0x12FE5D0, 0x13047CB, 0x13B8C10, 0x13C0780, 0x13C457D, 0x13CE710, 0x13D00D0, 0x13D0E50, 0x13D27E0, 0x13DEB00, 0x13DF890, 0x13E05F0, 0x13ED3FC, 0x140CD8C, 0x14149B0, 0x1420CD0, 0x1421A20, 0x1439F10, 0x14403B0, 0x1442336, 0x144DD20, 0x144F690, 0x14558F0, 0x1461BF0, 0x146DEF0, 0x146F880, 0x14705E0, 0x1471B64, 0x147A9E0, 0x1789E20, 0x1794EC6, 0x17E2112, 0x18464DD, 0x18599A0, 0x185E310, 0x1863C00, 0x1865580, 0x1874F40, 0x1886970, 0x189CB66, 0x18D4F60, 0x18D5CC0, 0x18D7630, 0x18D8FB0, 0x18D9D20, 0x18DBC7E, 0x18E3808, 0x1C13030, 0x1C13AB0, 0x1C15866, 0x1C48F2A, 0x1C84C3E, 0x1C9285F, 0x1C92D00, 0x1CB65F0, 0x1CBAF60, 0x1CC11C0, 0x1CC2B60, 0x1CCD855, 0x1DED2EA, 0x1F16D70, 0x1F186E0, 0x1F18760, 0x1F294B0, 0x1F2E015, 0x1F40BD0, 0x1F58C10, 0x1F5A5B0, 0x1F5A630, 0x1F5D880, 0x1F69775, 0x1F7ACE0, 0x1F7C680, 0x1F7C857, 0x1F88C10, 0x1F93FF0, 0x1F9769F, 0x1FA3360, 0x1FAA9F0, 0x1FB2445, 0x1FBD0B0, 0x1FC3C14, 0x206C100, 0x206DF32, 0x2082530, 0x20825B0, 0x208F720, 0x208F840];
// scanstring: "LR=1520C8"
// let textureDataOffsets_f_nightclub_exterior = [0x0FD1C0, 0x0FE550, 0x10C5B0, 0x113F20, 0x114C90, 0x116610, 0x117F90, 0x119980, 0x11C4C0, 0x13EA80, 0x1403D0, 0x141F10, 0x159FD0, 0x15AD50, 0x15C7B0, 0x162B20, 0x1D1DC0, 0x1D6F80, 0x1ECDD0, 0x1EE820, 0x1F3610, 0x1F4F20, 0x1F51D0, 0x20EDE0, 0x220FC0, 0x224350, 0x225D10, 0x227840, 0x23D350, 0x248900, 0x24A2A0, 0x24EDC0, 0x25DC10, 0x26FA00, 0x291C20, 0x2AA190, 0x2EC0E0, 0x2EE610, 0x2F47A0, 0x2F6BC0, 0x300200, 0x314C90, 0x32B620, 0x395160, 0x3A30A0, 0x3A3BA0, 0x3A8280, 0x3AA3E0, 0x3AB220, 0x3B5870, 0x3B6F70, 0x42D3A0, 0x42ED30, 0x430810, 0x43F870, 0x44DE50, 0x471F60, 0x480C00, 0x491900, 0x4DF1E0, 0x525BD0, 0x526A70, 0x5341B0, 0x535520, 0x5926B0, 0x597030, 0x59B9B0, 0x59D510, 0x5A9890, 0x5B3E90, 0x5C05F0, 0x5CA7D0, 0x5CD990, 0x5CDC30, 0x5CF6C0, 0x5D75E0, 0x5DA690, 0x5E0A50, 0x5E9490, 0x5F6370, 0x5F64F0, 0x608670, 0x609120, 0x62B2D0, 0x62CD80, 0x634870, 0x636230, 0x6393C0, 0x63DE40, 0x6547C0, 0x655E20, 0x65BF00, 0x65C0A0, 0x662C50, 0x6D4D10, 0x6DAEA0, 0x6DBD50, 0x6E9DB0, 0x730D70, 0x7356E0, 0x738000, 0x73AB20, 0x751660, 0x75D980, 0x76F220, 0x803E10, 0x8075C0, 0x80D120, 0x81B5C0, 0x8288A0, 0x83CD80, 0x83DAD0, 0x83E840, 0x83F6D0, 0x84C060, 0x84DEE0, 0x877CC0, 0x88AC70, 0x895510, 0x8AA360, 0x8BA620, 0x8CD260, 0xA1DCC0, 0xA257C0, 0xA2A680, 0xA32280, 0xA34070, 0xA4E800, 0xA549D0, 0xA5BD40, 0xA6D030, 0xA742A0, 0xA7C820, 0xA7D1E0, 0xA93870, 0xC87C70, 0xC89610, 0xC8A3A0, 0xC8D520, 0xC8EEA0, 0xC93800, 0xC951A0, 0xC99B20, 0xC9A890, 0xC9C360, 0xCA5FB0, 0xCA7910, 0xCAFA00, 0xDA05A0, 0xDCFC20, 0xDD2F30, 0xDD60B0, 0xDDB220, 0xE35C80, 0xE78120, 0xE7FC80, 0xE8AEA0, 0xE8C810, 0xE8E180, 0xE8FB10, 0xE94410, 0xE94D70, 0xEA6EE0, 0xEA88A0, 0xEAA210, 0xEABBB0, 0xEAD550, 0xEAEC50, 0xEB0DC0, 0xEB2760, 0xEBAFD0, 0xEEBCE0, 0xEF1C00, 0xEF7D80, 0xEFB450, 0x1082430, 0x10885D0, 0x1089F60, 0x108C6C0, 0x10A77C0, 0x10A8540, 0x10AB100, 0x123F630, 0x1249D60, 0x125DA30, 0x1267120, 0x1267B70, 0x12689B0, 0x1275340, 0x1276CD0, 0x12781F0, 0x1280600, 0x12876A0, 0x12CD0F0, 0x12D0340, 0x12D10A0, 0x12D8230, 0x12EA470, 0x12F0B50, 0x12FE640, 0x1304CF0, 0x13B8D40, 0x13C0830, 0x13C4730, 0x13CE7C0, 0x13D0140, 0x13D0EC0, 0x13D2A00, 0x13DEB70, 0x13DF900, 0x13E0750, 0x13ED540, 0x140CF70, 0x1414BD0, 0x1420D40, 0x1421BE0, 0x143A060, 0x1440420, 0x14424F0, 0x144DD90, 0x144F7C0, 0x1455B10, 0x1461E10, 0x146DF60, 0x146F8F0, 0x1470650, 0x1471BD0, 0x147BDE0, 0x1789E90, 0x1794FF0, 0x17E2390, 0x18465B0, 0x1859A10, 0x185E3D0, 0x1863C70, 0x1865670, 0x1875130, 0x1886AC0, 0x189D220, 0x18D4FD0, 0x18D5D30, 0x18D76A0, 0x18D9020, 0x18D9D90, 0x18DBD10, 0x18E4AC0, 0x1C130A0, 0x1C13B10, 0x1C15C80, 0x1C49330, 0x1C84E40, 0x1C92870, 0x1C930B0, 0x1CB6660, 0x1CBB090, 0x1CC1230, 0x1CC2C90, 0x1CCF320, 0x1DEE440, 0x1F16DE0, 0x1F186F0, 0x1F18A10, 0x1F295D0, 0x1F2E140, 0x1F40EC0, 0x1F58C80, 0x1F5A5C0, 0x1F5A760, 0x1F5DA00, 0x1F69980, 0x1F7AD50, 0x1F7C690, 0x1F7C920, 0x1F88D40, 0x1F940C0, 0x1F978B0, 0x1FA34E0, 0x1FAAB90, 0x1FB2510, 0x1FBD180, 0x1FC3FD0, 0x206C170, 0x206E0C0, 0x2082540, 0x2082880, 0x208F730, 0x2096220];
// scanstring: "LR=1868D0,11D5D0,02A038"
let scriptOffsets_f_nightclub_exterior = [0x0FE055, 0x11B95E, 0x11C002, 0x23D130, 0x291642, 0x2918D8, 0x2F653B, 0x2F69A5, 0x2FF537, 0x2FFD3D, 0x32AA93, 0x32AD5F, 0x32B02B, 0x32B2F7, 0x394C65, 0x3B6771, 0x43F365, 0x493400, 0x4938A3, 0x493CC8, 0x494375, 0x49540B, 0x496069, 0x496AE3, 0x49853C, 0x49A19A, 0x49AD25, 0x49AF8C, 0x49B151, 0x49B46C, 0x49B97A, 0x49BD54, 0x49BF4C, 0x49C170, 0x49D132, 0x49E0F4, 0x49F3D8, 0x49FDF8, 0x4A00E1, 0x4A0372, 0x4A06DF, 0x4A09F7, 0x4A0C01, 0x4A2ED6, 0x4A416B, 0x4A44BA, 0x4A4BF8, 0x4A50F1, 0x4A548F, 0x4A570B, 0x4A5A4A, 0x4A5DF5, 0x4A61A0, 0x4A652E, 0x4A68CB, 0x4A6BCC, 0x4A6E9A, 0x4A71FB, 0x4A7800, 0x4A7CAE, 0x4A7F5A, 0x4A8303, 0x4A8951, 0x4AA175, 0x4AB178, 0x4ABD7D, 0x4ACB34, 0x4AD86B, 0x4ADE0D, 0x4AF67D, 0x4B0CB9, 0x4B1496, 0x4B184B, 0x4B1BF1, 0x4B24BB, 0x4B2F53, 0x4B59F2, 0x4B6C35, 0x4B78DC, 0x4B7F66, 0x4B8744, 0x4B8FF8, 0x4B9584, 0x4B9E07, 0x4BA968, 0x4BB234, 0x4BBC6C, 0x4BC169, 0x4BC3A8, 0x4BD8C4, 0x4BE674, 0x4BEC5D, 0x4BF118, 0x4BF5FE, 0x4BFAE4, 0x4BFFCA, 0x4C04B1, 0x4C0999, 0x4C0E39, 0x4C151B, 0x4C1942, 0x4C29CD, 0x4C3857, 0x4C599B, 0x4C69E3, 0x4C6C88, 0x4C6E5B, 0x4C76B2, 0x4C7D62, 0x4C8234, 0x4C8791, 0x4C8C81, 0x4C95E4, 0x4C9D72, 0x4CA214, 0x4CA7A2, 0x4CADA4, 0x4CB3A6, 0x4CB9A8, 0x4CBCBF, 0x4CC50E, 0x4CCB7D, 0x4CCFD2, 0x4CD41C, 0x4CDA56, 0x4CDF7A, 0x4CE1F0, 0x4CFCAA, 0x4D09F2, 0x4D0D51, 0x4D0FF6, 0x4D2389, 0x4D2F40, 0x4D3B3B, 0x4D407B, 0x4D4E87, 0x4D599E, 0x4D5FA9, 0x4D6835, 0x4D7294, 0x4D7721, 0x4D7B1C, 0x4D7E5F, 0x4D8064, 0x4D876D, 0x4D8CDE, 0x4D9537, 0x4D9BAD, 0x4DB169, 0x4DBC84, 0x4DC294, 0x4DC617, 0x4DCB10, 0x4DD16C, 0x4DD462, 0x4DD9D8, 0x4DDE31, 0x4DE9F7, 0x4DF0C8, 0x5C02E8, 0x5F5F46, 0x737A5F, 0x76AA9B, 0x76B224, 0x76B3C5, 0x76B6EF, 0x76BAF1, 0x76C045, 0x76C614, 0x76CA73, 0x76CFBA, 0x76D581, 0x76D9DF, 0x76DD9E, 0x76E15F, 0x76E4BF, 0x76E7FB, 0x76EC68, 0x807472, 0x83CBFF, 0x876B43, 0x876EDA, 0x8774B7, 0x87792C, 0x8AA104, 0x8C4E8D, 0x8C727A, 0x8C81F9, 0x8C86BA, 0x8C8B7B, 0x8C903C, 0x8C94FD, 0x8C99BE, 0x8C9E7F, 0x8CA340, 0x8CA801, 0x8CACC3, 0x8CB185, 0x8CB646, 0x8CB8D2, 0x8CBAA4, 0x8CBC76, 0x8CBE48, 0x8CC01A, 0xA331AB, 0xA336A9, 0xA3398C, 0xA33BB0, 0xA33DFA, 0xA545A4, 0xA740B8, 0xA7B54B, 0xA7CF0D, 0xA8A803, 0xA8DADB, 0xA8DC7A, 0xA8DFCC, 0xA8E3DC, 0xA8E73B, 0xA8EB14, 0xA8EE71, 0xA8F2D3, 0xA8F720, 0xA8FA85, 0xA8FDEC, 0xA900CD, 0xA90459, 0xA90988, 0xA90F4F, 0xA91514, 0xA9190B, 0xA91BFE, 0xA91EF8, 0xA9234E, 0xCAB234, 0xCACB6F, 0xCACE57, 0xCAD11C, 0xCAD39F, 0xCAD5D8, 0xCAD8D6, 0xCADE5A, 0xCAE681, 0xCAED3C, 0xCAF260, 0xE35737, 0xE77D38, 0xE946D3, 0xE94A3D, 0xEAE98E, 0xEB8B0D, 0xEB9BD9, 0xEB9F9C, 0xEBA18D, 0xEBA48E, 0xEBA7D1, 0xEF9A6D, 0xEF9F4A, 0xEFA3F6, 0x108C259, 0x10AA00A, 0x10AA3AF, 0x10AA7DD, 0x123F204, 0x1277E83, 0x1286DD9, 0x12F07DD, 0x1302377, 0x13035D7, 0x1303A00, 0x1303D19, 0x13041FB, 0x13046B1, 0x13C3CAB, 0x13C4392, 0x13ED2FA, 0x140CC75, 0x14421BC, 0x14716F6, 0x1471A7E, 0x14743BA, 0x1474DCD, 0x14759A1, 0x14760AB, 0x147692F, 0x14772D4, 0x1477C15, 0x147857C, 0x1478B84, 0x1478EFE, 0x1479441, 0x147992A, 0x1479F9C, 0x147A78F, 0x1793764, 0x1794D8A, 0x17E17B8, 0x17E1E31, 0x184577D, 0x184619A, 0x189C54A, 0x189CA35, 0x18DBB12, 0x18E113C, 0x18E194F, 0x18E1F1D, 0x18E22F7, 0x18E26CB, 0x18E2B95, 0x18E32D4, 0x18E3734, 0x1C156AE, 0x1C44C41, 0x1C47AC7, 0x1C849E4, 0x1C90350, 0x1C927D1, 0x1CCB294, 0x1CCC556, 0x1CCC9EC, 0x1CCD4BA, 0x1DDE480, 0x1DDE6E4, 0x1DDE948, 0x1DDEC44, 0x1DE099C, 0x1DE197B, 0x1DE1E37, 0x1DE21A5, 0x1DE23B4, 0x1DE26BF, 0x1DE301A, 0x1DE3742, 0x1DE3E44, 0x1DE41AE, 0x1DE467F, 0x1DE4BFB, 0x1DE4F46, 0x1DE51B8, 0x1DE56C2, 0x1DE5A54, 0x1DE5FD7, 0x1DE6397, 0x1DE678C, 0x1DE6A87, 0x1DE739A, 0x1DE79ED, 0x1DE8392, 0x1DE9152, 0x1DE9746, 0x1DE994C, 0x1DE9C65, 0x1DE9FC1, 0x1DEA2A2, 0x1DEA54D, 0x1DEA7B8, 0x1DEAA8E, 0x1DEAD14, 0x1DEAFFF, 0x1DEB28F, 0x1DEB57A, 0x1DEB808, 0x1DEBAF3, 0x1DEBDC0, 0x1DEC047, 0x1DEC6A5, 0x1DECBC8, 0x1DECF24, 0x1DED21F, 0x1F2DC45, 0x1F69518, 0x1F7C7F1, 0x1F88845, 0x1F975E1, 0x1FB23E1, 0x1FC3893, 0x1FC3B55, 0x206DE0D];
// scanstring: "LR=10CCD0,10E8C0,027BEC"
let meshcontOffsets_f_nightclub_exterior = [0x107E63, 0x1106C3, 0x1197A3, 0x1345D3, 0x136E69, 0x138E5F, 0x13B405, 0x13BDB5, 0x13DC69, 0x158A26, 0x158F1E, 0x159416, 0x160B1C, 0x160EEA, 0x161429, 0x1D1DD3, 0x1EB302, 0x1EBCA4, 0x1EBF97, 0x1F1D12, 0x1F2730, 0x20E520, 0x23BEC2, 0x246A91, 0x246F7D, 0x247967, 0x25B2D3, 0x25CC85, 0x25D451, 0x26E423, 0x28EB5C, 0x28EFE1, 0x2A831E, 0x2A8EEC, 0x2EAC0E, 0x2EB3BE, 0x2ECCF3, 0x2ED867, 0x2FDF82, 0x2FE59C, 0x310313, 0x3244A3, 0x373733, 0x382E88, 0x3834B9, 0x38739B, 0x387C56, 0x391598, 0x3926C4, 0x39EA73, 0x3A38B3, 0x3A7FB3, 0x3A9A93, 0x3B3463, 0x3B4D47, 0x42A57E, 0x42AB38, 0x42BC90, 0x42C6AE, 0x43C489, 0x43E48A, 0x449583, 0x47ED0C, 0x47FF84, 0x490222, 0x490DF0, 0x4E2436, 0x530783, 0x5346C3, 0x5C5703, 0x5C8175, 0x5CB0E3, 0x5CD9A3, 0x5CDA15, 0x5CDAE4, 0x5D6ED3, 0x5D96F3, 0x5E06A3, 0x634593, 0x6DB3B3, 0x739813, 0x7D5158, 0x7D5618, 0x804323, 0x8043B3, 0x806C62, 0x806E5A, 0x816E33, 0x823AD3, 0x8349B3, 0x8746DA, 0x874E9F, 0x875400, 0x8828D3, 0x892BB2, 0x89309E, 0x894149, 0x8A79BC, 0x8A8181, 0x8A8856, 0x8B9D32, 0x8C1FF6, 0x924B73, 0x98A8C1, 0x9955A0, 0x99943E, 0x9A5C7E, 0x9AAC13, 0x9B406E, 0x9B785B, 0x9C1B68, 0x9C5928, 0x9CDB42, 0x9D06D4, 0x9DAAB5, 0x9DE7D7, 0x9E8627, 0x9EBC0B, 0x9F2230, 0x9F4FB5, 0x9FC1C4, 0x9FF638, 0xA022DD, 0xA03265, 0xA0FF5B, 0xA14F0B, 0xA16DFE, 0xA17BBC, 0xA1BC55, 0xA1F5D3, 0xA26FD3, 0xA2CB93, 0xA3C583, 0xA4D2ED, 0xA4E3F8, 0xA50D13, 0xA572E3, 0xA59521, 0xA59960, 0xA5B796, 0xA75FB3, 0xA819F3, 0xA81A67, 0xC33F91, 0xC357AF, 0xC35BF6, 0xC3654D, 0xC368CA, 0xCA459A, 0xD5B310, 0xD5B84C, 0xD5C74C, 0xD5D64C, 0xDAE2B3, 0xDD2C33, 0xE0DF33, 0xE322D9, 0xE34C61, 0xE6C193, 0xE78633, 0xE78708, 0xE78C0C, 0xE7EF75, 0xE87493, 0xEA5B5A, 0xEE6D2F, 0xEE7AC7, 0xEE8319, 0xEE9A3A, 0xEEAA44, 0xEEE1F3, 0x1011177, 0x1011376, 0x1012BB3, 0x1016D07, 0x1017455, 0x1017E5B, 0x1017EFE, 0x1018BBE, 0x12174D0, 0x121A72F, 0x1241F43, 0x1245F36, 0x1246173, 0x12499D2, 0x125AA73, 0x125AB03, 0x125D0AA, 0x125D2B7, 0x1264B43, 0x1267133, 0x127D303, 0x127E211, 0x12BFBB4, 0x12BFE02, 0x12C0E77, 0x12C2037, 0x12C254F, 0x12C2D90, 0x12C3A42, 0x12C417C, 0x13B6ED6, 0x13B7709, 0x13BC953, 0x13CD791, 0x1413303, 0x1413B12, 0x1440073, 0x144C02A, 0x144CF18, 0x14733E3, 0x1677B53, 0x167ADB2, 0x167B1A4, 0x167B8C6, 0x167D48D, 0x167EAB8, 0x167FCDE, 0x167FF2C, 0x168017A, 0x1680AB6, 0x1680B79, 0x1681E14, 0x1682E15, 0x168368E, 0x1684CDC, 0x1687192, 0x16875A7, 0x16884B5, 0x1688C85, 0x1689455, 0x1689C25, 0x168A3F5, 0x168ABC5, 0x168B395, 0x168BE4D, 0x168BEBF, 0x17DB3D9, 0x17DF848, 0x182ECA3, 0x18579C3, 0x18711CA, 0x1871E4A, 0x1872D5B, 0x1881543, 0x189B142, 0x18C880B, 0x18C8CF7, 0x18C950D, 0x18C9D92, 0x18CCC95, 0x18CEDB7, 0x18D0EF5, 0x18DD523, 0x18DD609, 0x18DFB0E, 0x1AF3EE9, 0x1AF6231, 0x1AF891F, 0x1AF9F3A, 0x1AFADF7, 0x1AFBDC3, 0x1AFC997, 0x1AFD87F, 0x1AFDC08, 0x1AFFB82, 0x1AFFEED, 0x1B01428, 0x1B0149A, 0x1B0206D, 0x1B02C40, 0x1B03813, 0x1B043E6, 0x1B04FB9, 0x1B05B8C, 0x1B069FA, 0x1B21073, 0x1B2111E, 0x1B21EBD, 0x1C14F23, 0x1C2F993, 0x1C41969, 0x1C87753, 0x1C8A121, 0x1C8A35E, 0x1C8C969, 0x1C92883, 0x1CB21C3, 0x1CB2843, 0x1CB2AFB, 0x1DDB9EF, 0x1DDC8E6, 0x1E7F953, 0x1EB00E6, 0x1EB189A, 0x1EB1AE2, 0x1EB1D2A, 0x1EB21E1, 0x1EB3477, 0x1EB3B4E, 0x1EB3D8D, 0x1EB7BE9, 0x1EB80CD, 0x1EB88BD, 0x1EBF834, 0x1EBFC63, 0x1EC6D7B, 0x1EC7079, 0x1EC770D, 0x1EC7D56, 0x1EE92C7, 0x1EE9467, 0x1EEC2A2, 0x1EEC4F0, 0x1EEC73E, 0x1EFB29C, 0x1F05C2F, 0x1F0FADF, 0x1F1005D, 0x1F1432D, 0x1F14610, 0x1F147B0, 0x1F20B23, 0x1F2C28E, 0x1F2C6CF, 0x1F3BA53, 0x1F56E58, 0x1F57509, 0x1F580D7, 0x1F62F13, 0x1F76D89, 0x1F78644, 0x1F79C6A, 0x1F7A47F, 0x1F8EE53, 0x1F9FA96, 0x1FA1DE1, 0x1FA9513, 0x1FA9DB4, 0x1FAFCA3, 0x1FC3193, 0x20540E3, 0x20633AE, 0x20638EA, 0x206AFB5, 0x206B720, 0x207D0D3, 0x2081B7D, 0x2517B33, 0x2D06CB5, 0x2D0FEFE];

// From https://docs.google.com/spreadsheets/d/1bdhTl2IvXVWOjnjhpgUTH0kg6e-RcioezIYrsi-_mso/edit#gid=0
// TODO: Should titles be world titles instead of ep?
const sceneDescs = [
    "The Black Chateau (Paris, France)",
    new Sly2LevelSceneDesc("f_nightclub_exterior", "The Black Chateau (Extermal)",
        objectOffsets_f_nightclub_exterior, textureDescOffsets_f_nightclub_exterior, scriptOffsets_f_nightclub_exterior, meshcontOffsets_f_nightclub_exterior),
];

const id = 'Sly2';
const name = 'Sly 2: Band of Thieves';
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
