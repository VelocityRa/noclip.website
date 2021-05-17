import ArrayBufferSlice from '../ArrayBufferSlice';
import { mat4, vec2, vec3, quat } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import { IS_DEVELOPMENT } from "../BuildVersion";
import { assert, hexzero, hexzero0x, leftPad, spacePad } from '../util';
import { NamedArrayBufferSlice } from "../DataFetcher";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end, transformVec3Mat4w1 } from '../MathHelpers';
import { downloadBuffer } from '../DownloadUtils';
import { makeZipFile, ZipFileEntry } from '../ZipFile';
import { Sly2Renderer } from './Sly2Renderer';
import { Texture } from './SlyData';
import { DataStream } from "./DataStream";
import { sprintf } from "./sprintf";
import { Accessor, Document, WebIO, Node as GLTFNode, Mesh as GLTFMesh, Material as GLTFMaterial } from '@gltf-transform/core';


// TODO: move shit to other files

export interface ObjectEntry {
    index: number;
    name: string;
    type: string; // char
    id0: number;
    count: number;
}
export function parseObjectEntries(s: DataStream): ObjectEntry[] {
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

export class SzmeChunk {
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

export class Szme {
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

export interface MeshChunk {
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

    gltfMesh: (GLTFMesh | null);
}


export interface MeshC2Entry {
    transformMatrix: (mat4 | null);
}

// TODO: is u6 & g4 texture ID?

// TODO: type==3 p6 p5 is tristrip
// TODO: maybe u9 is local offset?

export class Mesh {
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

                    let gltfMesh = null;

                    this.chunks.push({
                        positions, normals, texCoords, vertexColor, vertexColorFloats, trianglesIndices1,
                        unkIndices1, trianglesIndices2, unkIndices2, name, gltfMesh
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

export class MeshContainer {
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

export class TextureClut {
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

export class TextureImage {
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

export class TextureIndices {
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

export class TextureDesc {
    public indices: TextureIndices[] = [];

    constructor(s: DataStream) {
        s.skip(0x17);
        const innerCount = s.u8();
        s.skip(2);
        for (let i = 0; i < innerCount; i++)
            this.indices.push(new TextureIndices(s));
    }
}

export class TextureContainer {
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

export class LevelObject {
    public offset: number;
    public header: ObjectEntry;
    public meshContainers: MeshContainer[] = [];
    public textureContainer: TextureContainer;
    public texturesDiffuse: Texture[] = [];
    public texturesUnk: Texture[] = [];
}

export class DynamicObjectInstance {
    public objId0: number;
    public matrix: mat4;

    constructor(s: DataStream) {
        this.objId0 = s.u32();
        s.skip(1 + 2);
        this.matrix = s.mat4();
    }
}
