import ArrayBufferSlice from '../ArrayBufferSlice';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { assert, hexzero, hexzero0x, spacePad } from '../util';
import { clamp, range, range_end } from '../MathHelpers';
import * as Settings from './SlyConstants';
import { vec2, vec3, vec4, mat4, ReadonlyMat4, ReadonlyVec3 } from "gl-matrix";
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D, drawWorldSpacePoint } from "../DebugJunk";

// TODO: move?
export class DataStream {
    constructor(
        public buffer: ArrayBufferSlice,
        public view: DataView = buffer.createDataView(),
        public offs: number = 0,
    ) {
    }

    public readUint8(): number { return this.view.getUint8(this.offs++); }
    public readUint16(): number { const v = this.view.getUint16(this.offs, true); this.offs += 0x02; return v; }
    public readUint32(): number { const v = this.view.getUint32(this.offs, true); this.offs += 0x04; return v; }
    public readFloat32(): number { const v = this.view.getFloat32(this.offs, true); this.offs += 0x04; return v; }
    public readVec3(): vec3 { return vec3.fromValues(this.readFloat32(), this.readFloat32(), this.readFloat32()); }
    public readVec4(): vec4 { return vec4.fromValues(this.readFloat32(), this.readFloat32(), this.readFloat32(), this.readFloat32()); }
    public readMat4(): mat4 {
        return mat4.fromValues(
            this.readFloat32(), this.readFloat32(), this.readFloat32(), 0, //
            this.readFloat32(), this.readFloat32(), this.readFloat32(), 0, //
            this.readFloat32(), this.readFloat32(), this.readFloat32(), 0, //
            this.readFloat32(), this.readFloat32(), this.readFloat32(), 1, //
        );
    }

    public readUint8At(offset: number): number { return this.view.getUint8(offset); }
    public readUint16At(offset: number): number { return this.view.getUint16(offset, true); }
    public readUint32At(offset: number): number { return this.view.getUint32(offset, true); }

    public align(alignment: number) { this.offs += (-this.offs) & (alignment - 1); }
}

interface CLUTMetaEntry {
    unk0: number;
    colorCount: number;
    colorSize: number;
    offset: number; // Relative to start of color palette data
}

export function parseCLUTMetaEntries(stream: DataStream): CLUTMetaEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<CLUTMetaEntry>();

    for (let i = 0; i < entryCount; ++i) {
        const unk0 = stream.readUint32(); // TODO
        const colorCount = stream.readUint16();
        const colorSize = stream.readUint16();
        const offset = stream.readUint32();
        entries.push({ unk0, colorCount, colorSize, offset });
    }

    return entries;
}

interface ImageMetaEntry {
    width: number;
    height: number;
    offset: number; // Relative to start of color palette data
}

export function parseImageMetaEntries(stream: DataStream): ImageMetaEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<ImageMetaEntry>();

    for (let i = 0; i < entryCount; ++i) {
        const width = stream.readUint16();
        const height = stream.readUint16();
        stream.offs += 12;
        const offset = stream.readUint32();
        entries.push({ width: width, height: height, offset: offset });
    }

    return entries;
}

export interface TextureEntry {
    clutIndices: Uint16Array
    imageIndices: Uint16Array
    unkCol1: number
    unkCol2: number
}

export function parseTextureEntries(stream: DataStream): TextureEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<TextureEntry>();
    stream.offs += 0x18;

    for (let i = 0; i < entryCount; ++i) {
        stream.offs += 4;
        const imageCount = stream.readUint8();
        const clutCount = stream.readUint8();

        let imageIndices = new Uint16Array(imageCount);
        for (let i in range_end(0, imageCount)) {
            imageIndices[i] = stream.readUint16();
        }

        let clutIndices = new Uint16Array(clutCount);
        for (let i in range_end(0, clutCount)) {
            clutIndices[i] = stream.readUint16();
        }

        stream.offs += 0x4;
        const unkCol1 = stream.readUint32();
        const unkCol2 = stream.readUint32();
        stream.offs += 0x8;
        let unk2 = stream.readUint16();
        if (unk2 > 0)
            stream.offs += 0x1C;

        entries.push({ clutIndices, imageIndices, unkCol1, unkCol2 });
    }

    return entries;
}

function getCsm1ClutIndices(): Uint8Array {
    let tbl = new Uint8Array(256);
    for (let i of range_end(0, 0x100, 0x20)) {
        for (let j of range_end(i, i + 8)) {
            tbl[j] = j;
            tbl[j + 8] = j + 0x10;
            tbl[j + 0x10] = j + 0x8;
            tbl[j + 0x18] = j + 0x18;
        }
    }
    return tbl;
}

export class Texture {
    public texelsRgba: Uint8Array;
    public viewerTexture: Viewer.Texture[] = [];

    // Calculated via a heuristic (check if texture palette contains non-opaque texels)
    public isFullyOpaque = true;

    private static csm1ClutIndices = getCsm1ClutIndices();

    private canvasTex: (Viewer.Texture | null) = null;

    constructor(public texEntryIdx: number, paletteBuf: ArrayBufferSlice, imageBuf: ArrayBufferSlice,
        public width: number, public height: number, colorCount: number, colorSize: number, public name: string = "N/A") {

        this.texelsRgba = new Uint8Array(width * height * 4);

        let texels_slice = imageBuf.createTypedArray(Uint8Array);
        let palette_slice = paletteBuf.createTypedArray(Uint8Array);

        for (let i of range_end(0, width * height)) {
            const idx = Texture.csm1ClutIndices[texels_slice[i]] * 4;

            let offs: number;
            if (Settings.MESH_EXPORT) {
                // todo this is bad
                const x = i % width;
                const y = Math.floor(i / width);
                const inv_y = height - y - 1; //(-(y - (width / 2))) + width / 2 - 1;
                offs = (inv_y * width + x) * 4;
            } else {
                offs = i * 4;
            }

            this.texelsRgba[offs + 0] = palette_slice[idx + 0];
            this.texelsRgba[offs + 1] = palette_slice[idx + 1];
            this.texelsRgba[offs + 2] = palette_slice[idx + 2];
            this.texelsRgba[offs + 3] = palette_slice[idx + 3];
        }

        for (let i = 0; i < this.texelsRgba.byteLength; i += 4) {
            if (this.texelsRgba[i + 3] != 0x80) {
                this.isFullyOpaque = false;
                break;
            }
        }
    }

    public toCanvas(): Viewer.Texture {
        if (this.canvasTex)
            return this.canvasTex;

        const canvas = document.createElement("canvas");
        const width = this.width;
        const height = this.height;
        canvas.width = width;
        canvas.height = height;
        canvas.title = this.name;

        // todo: flip?

        // Shaders double the texture alpha, do that here too to get correct output in the viewer

        const texelsDoubleAlpha = new ArrayBufferSlice(this.texelsRgba.buffer).copyToBuffer();
        const texelsDoubleAlphaU8 = new ArrayBufferSlice(texelsDoubleAlpha).createTypedArray(Uint8Array)

        for (let i = 0; i < texelsDoubleAlphaU8.byteLength; i += 4)
            texelsDoubleAlphaU8[i + 3] = clamp(texelsDoubleAlphaU8[i + 3] * 2, 0x00, 0xFF);

        const ctx = canvas.getContext("2d")!;
        const imgData = ctx.createImageData(canvas.width, canvas.height);
        imgData.data.set(texelsDoubleAlphaU8);
        ctx.putImageData(imgData, 0, 0);
        const surfaces = [canvas];

        const extraInfo = new Map<string, string>();
        // extraInfo.set('Format', 'IDTEX8-CSM1 (PS2)'); // todo: wrong

        this.canvasTex = { name: this.name, surfaces, extraInfo };

        return this.canvasTex;
    }
}

export interface SzmeChunk {
    origin: vec3;
    positions: Float32Array; // vec3
    rotations: Float32Array; // vec3
    unkColors: Uint32Array;  // RGBA
    texCoords: Float32Array; // vec2
    unkIndices: Uint32Array;   // RGBA
    // lightingFloats: Float32Array;   // vec4
    texIndex: number;        // u16
    unkByte1: number;        // u8
    unkByte2: number;        // u8
    // TODO: expose more fields
}

export interface SzmeHeader {
    position: vec3;
    // TODO: expose more fields
}

export interface MeshChunk {
    positions: Float32Array; // vec3
    normals: Float32Array;  // vec3
    texCoords: Float32Array;  // vec2
    vertexColor: Uint32Array; // RGBA (?)
    vertexColorFloats: Float32Array;   // vec4

    trianglesIndices: Uint16Array;
    unkIndices: Uint16Array;

    szme: SzmeChunk | undefined;

    name: string; // for debugging
    flags: number; // redundant since it's the same as the parent Mesh, used for debugging (layers system)
}

export let totalChunkIndex = 0;

/*
0b10110 (0x16) contains lights (so, emissive material?)
0b100 is for animated textures maybe?
*/
export enum MeshFlag {
    None = 0,

    Static = 1 << 1,
    NoShading = 1 << 2, // maybe
    Skybox = 1 << 3,
    //Spotlights = 1 << 4,
    TreasureKeys = 1 << 5,
    Coins = 1 << 7, // and glow part of treasure keys (?)
}

export function parseMeshes(buffer: ArrayBufferSlice): MeshContainer[] {
    const binView = buffer.createDataView();
    let stream = new DataStream(buffer, binView);

    let meshContainers: MeshContainer[] = [];

    let meshIndex = 0;
    for (stream.offs = 0; stream.offs < binView.byteLength - 4; stream.offs++) {
        if (binView.getUint32(stream.offs, true) === Mesh.szmsMagic &&
            binView.getUint32(stream.offs + 4, true) === Mesh.szmsVersion) {

            let field0x40 = 0;
            let found = false;

            for (let j = 0; j < 0xB; ++j) {
                if ((stream.readUint16At(stream.offs - 4 - 6 - j * 4) == 0xFFFF) &&
                    ((stream.readUint8At(stream.offs - 4 - 4 - j * 4) == 0x01) ||
                        (stream.readUint8At(stream.offs - 4 - 4 - j * 4) == 0x00))) {
                    if (stream.readUint8At(stream.offs - 4 - 1 - j * 4) == j) {
                        field0x40 = j;
                        found = true;
                        break;
                    }
                }
            }

            if (!found) {
                console.log(`[${hexzero0x(stream.offs)}] field0x40 pattern not found`);
            }

            stream.offs -= 4 + (4 * field0x40 + 1);

            let meshContainer = new MeshContainer(stream, meshIndex, meshContainers.length);
            meshIndex += meshContainer.meshes.length;
            meshContainers.push(meshContainer);
        }
    }

    return meshContainers;
}

export class MeshContainer {
    public meshes: Mesh[] = [];
    public meshInstances: Mesh[] = [];

    public field0x40: number;

    constructor(stream: DataStream, meshIndex: number, public containerIndex: number) {
        console.log(`[${hexzero0x(stream.offs)}] SZMS container contId ${containerIndex} meshId ${meshIndex}`);

        this.field0x40 = stream.readUint8();
        stream.offs += this.field0x40 * 4;

        const meshCount = stream.readUint16();

        for (let i = 0; i < meshCount; ++i) {
            const mesh = new Mesh(stream, meshIndex, this);

            if (mesh.isInstance) {
                this.meshInstances.push(mesh);
            } else {
                this.meshes.push(mesh);
            }
            meshIndex++;
        }

        // TODO: flags2 etc
    }
}

export class Mesh {
    static readonly szmsMagic = 0x534D5A53; // "SZMS"
    static readonly szmeMagic = 0x454d5a53; // "SZME"

    static readonly szmsVersion = 4;

    public flags: number;
    public offset: number;

    public chunks: MeshChunk[] = [];
    public szmeHeader: (SzmeHeader | undefined);

    public isInstance: boolean; // Is an instatiation of a previously defined Mesh
    public instanceMeshIndex: number // Index to which (non-instance) mesh in this container to instantiate
    public instanceMatrix: mat4;

    constructor(stream: DataStream, public meshIndex: number, public container: MeshContainer) {
        this.offset = stream.offs;

        // Read flags
        this.flags = stream.readUint16();
        console.log(`container ${container.containerIndex} meshIndex ${meshIndex} flags ${hexzero(this.flags, 3)}`);

        this.isInstance = ((this.flags & 1) != 0);

        if (!this.isInstance) {
            // Read SZMS header

            if (stream.readUint32() != Mesh.szmsMagic)
                throw new Error(`[${hexzero0x(stream.offs)}] bad SZMS magic`);

            if (stream.readUint32() != 0x4)
                throw new Error(`[${hexzero0x(stream.offs)}] unsupported version`);

            if ((this.flags & 1) != 0)
                throw new Error(`[${hexzero0x(stream.offs)}] skipping mesh, has invalid flags: ${hexzero0x(this.flags)}`);

            const totalSize = stream.readUint32();

            // Read mesh header

            const startOffs = stream.offs;

            const unkMhdr0x00 = stream.readUint32();
            const unkMhdr0x04 = stream.readUint16();
            const szmsChunkCount = stream.readUint16();

            let meshOffsets: number[] = [];

            for (let i of range_end(0, szmsChunkCount)) {
                meshOffsets.push(stream.readUint32());
            }

            // console.log(sprintf('SZMS #%04d %05X %08X %s', index, totalSize, offset, meshOffsets));

            for (let meshOffs of meshOffsets) {
                stream.offs = startOffs + meshOffs;

                // Read vertex header

                const unkVtxHdr0x00 = stream.readUint32();
                const vertexCount = stream.readUint16();
                const unkVtxHdrCount = stream.readUint16();
                const vertexDataOffset = stream.readUint32();
                const indexHeaderOffset = stream.readUint32();

                const vertexDataSize = indexHeaderOffset - vertexDataOffset;

                stream.offs = startOffs + vertexDataOffset;

                // Read vertex data

                let positions = new Float32Array(vertexCount * 3);
                let normals = new Float32Array(vertexCount * 3)
                let texCoords = new Float32Array(vertexCount * 2);
                let vertexColor = new Uint32Array(vertexCount);
                let vertexColorFloats = new Float32Array(vertexCount * 4);

                for (let i = 0; i < vertexCount; ++i) {
                    positions[i * 3 + 0] = stream.readFloat32();
                    positions[i * 3 + 1] = stream.readFloat32();
                    positions[i * 3 + 2] = stream.readFloat32();

                    normals[i * 3 + 0] = stream.readFloat32();
                    normals[i * 3 + 1] = stream.readFloat32();
                    normals[i * 3 + 2] = stream.readFloat32();

                    texCoords[i * 2 + 0] = stream.readFloat32();
                    texCoords[i * 2 + 1] = stream.readFloat32();

                    vertexColor[i] = stream.readUint32();

                    stream.offs -= 4;
                    vertexColorFloats[i * 4 + 0] = stream.readUint8() / 255;
                    vertexColorFloats[i * 4 + 1] = stream.readUint8() / 255;
                    vertexColorFloats[i * 4 + 2] = stream.readUint8() / 255;
                    vertexColorFloats[i * 4 + 3] = stream.readUint8() / 255;
                }

                stream.offs = startOffs + indexHeaderOffset;

                // Read index header

                const triangleCount = stream.readUint16() * 3;
                const indexCount = stream.readUint16();
                const indexDataOffs1 = stream.readUint32();
                const indexDataOffs2 = stream.readUint32();

                // Read index data

                // Read triangle data

                stream.offs = startOffs + indexDataOffs1;
                let trianglesIndices = new Uint16Array(triangleCount)
                for (let i = 0; i < triangleCount; ++i) {
                    trianglesIndices[i] = stream.readUint16();
                }

                // Read index data

                stream.offs = startOffs + indexDataOffs2;
                let unkIndices = new Uint16Array(indexCount);

                for (let i of range_end(0, indexCount)) {
                    unkIndices[i] = stream.readUint16();
                }

                let meshAddr = startOffs - 2;
                let submeshAddr = startOffs + meshOffs;
                let submeshCount = spacePad(meshOffsets.length.toString(), 2);
                let name = `SZMS ${hexzero(meshAddr, 6)} ${hexzero(this.flags, 3)} ${submeshCount} | ${hexzero(submeshAddr)}`;

                let flags = this.flags; // redundant

                // These will be filled out later
                let szme: (SzmeChunk | undefined) = undefined;
                this.chunks.push({ positions, normals, texCoords, vertexColor, vertexColorFloats, trianglesIndices, unkIndices, szme, name, flags });
            }
        } else { // This is a mesh instance
            this.instanceMeshIndex = stream.readUint16()

            this.instanceMatrix = stream.readMat4();
        }

        // Read SZME header

        const szmeOffs = stream.offs;

        if (!this.isInstance) {
            if (stream.readUint32() != Mesh.szmeMagic)
                throw new Error(`bad SZME magic at ${hexzero0x(szmeOffs)}`);
        }

        if ((this.flags & MeshFlag.Static) != 0) {
            stream.readUint32();
        }
        if ((this.flags & 0x200) != 0) {
            stream.readFloat32();
        }
        if ((this.flags & 4) != 0) {
            stream.readFloat32();
        }
        if ((this.flags & MeshFlag.Skybox) != 0) {
            stream.readFloat32();
        }
        if ((this.flags & 0x10) != 0) {
            stream.readFloat32();
        }
        if ((this.flags & 0x20) != 0) {
            stream.readFloat32();
        }
        if ((this.flags & 0x40) != 0) {
            // meta entry alt
            // console.warn(`skipping 0x40 field at ${hexzero0x(stream.offs)}, flags: ${hexzero0x(this.flags, 3)}`);

            const unkU16 = stream.readUint16();
            if (unkU16 != 0)
                stream.offs += 0x1C;
        }
        if ((this.flags & 0x80) != 0) {
            const unkVec3 = stream.readVec3();
            const unkVec4 = stream.readVec4();
        }
        if (((this.flags & 0x100) != 0)) {
            const unk0x100u16 = stream.readUint16();
            const unk0x100u8 = stream.readUint8();

            if (unk0x100u8 != 0xFF) {
                const unkFloatArr = [stream.readFloat32(), stream.readFloat32(), stream.readFloat32(), stream.readFloat32()];
                const unkMat4 = stream.readMat4();
            }

            const unkU8Arr = [stream.readUint8(), stream.readUint8(), stream.readUint8()];
        }

        // Read SZME data

        const position: vec3 = stream.readVec3();
        const unkFloat0x14 = stream.readFloat32();
        stream.readUint16();
        const unkByte0x1A = stream.readUint8();
        const unkByte0x1B = stream.readUint8();
        const unkByte0x1C = stream.readUint8();

        if (!this.isInstance) {
            const szmeChunkCount = stream.readUint16();

            // if (szmsChunkCount != szmeChunkCount)
            //     throw new Error(`szmsChunkCount(${szmsChunkCount}) != szmeChunkCount(${szmeChunkCount})`);

            // if (szmeChunkCount < 0xFF) {
            for (let szmeChunkIndex = 0; szmeChunkIndex < szmeChunkCount; ++szmeChunkIndex) {
                const origin: vec3 = stream.readVec3();

                const unkFloat = stream.readFloat32();
                const unkCount1 = stream.readUint8();
                const unkCount2 = stream.readUint8();
                const unkCount3 = stream.readUint8();
                const unkCount4 = stream.readUint8();
                const unkCount5 = stream.readUint8();

                stream.align(4);

                let positions = new Float32Array(unkCount1 * 3);
                for (let i = 0; i < unkCount1 * 3; i += 3) {
                    positions[i + 0] = stream.readFloat32();
                    positions[i + 1] = stream.readFloat32();
                    positions[i + 2] = stream.readFloat32();
                }

                let rotations = new Float32Array(unkCount2 * 3);
                for (let i = 0; i < unkCount2 * 3; i += 3) {
                    rotations[i + 0] = stream.readFloat32();
                    rotations[i + 1] = stream.readFloat32();
                    rotations[i + 2] = stream.readFloat32();
                }

                let unkColors = new Uint32Array(unkCount3);
                for (let i = 0; i < unkCount3; i++) {
                    unkColors[i] = stream.readUint32();
                }

                let texCoords = new Float32Array(unkCount4 * 2);
                for (let i = 0; i < unkCount4 * 2; i += 2) {
                    texCoords[i + 0] = stream.readFloat32();
                    texCoords[i + 1] = stream.readFloat32();
                }

                let unkIndices = new Uint32Array(unkCount5);
                // let unkIndicesFloats = new Float32Array(unkCount5 * 4);
                for (let i = 0; i < unkCount5; i++) {
                    unkIndices[i] = stream.readUint32();
                    // stream.offs -= 4;
                    // unkIndicesFloats[i * 4 + 0] = stream.readUint8() / 255;
                    // unkIndicesFloats[i * 4 + 1] = stream.readUint8() / 255;
                    // unkIndicesFloats[i * 4 + 2] = stream.readUint8() / 255;
                    // unkIndicesFloats[i * 4 + 3] = stream.readUint8() / 255;
                    // if (szmeChunkIndex == 0)
                    // console.log(`AT ${hexzero0x(stream.offs-4)} is [${lightingFloats[i * 4 + 0]}, ${lightingFloats[i * 4 + 1]}, ${lightingFloats[i * 4 + 2]}, ${lightingFloats[i * 4 + 3]},]`);
                }

                const texIndex = stream.readUint16();

                // console.log(`[${hexzero0x(stream.offs)}] texID ${hexzero0x(texIndex)}`);

                const unkByte1 = stream.readUint8();
                const unkByte2 = stream.readUint8();

                stream.offs += unkByte2; // u8

                stream.offs += unkByte2 * unkCount1 * 4; // float

                // Read field_0x40_data
                if (container.field0x40 != 0) {
                    const unkPosCount = stream.readUint16();
                    stream.offs += unkPosCount * 4 * 3; // vec3

                    const unkNormalCount = stream.readUint16();
                    stream.offs += unkNormalCount * 4 * 3; // vec3

                    stream.offs += unkCount5 * 2; // u16, tri list

                    let nestedCount = container.field0x40 * 2 - 1;

                    stream.offs += unkCount5 * nestedCount * 2; // u16
                }

                this.chunks[szmeChunkIndex].szme = { origin, positions, rotations, unkColors, texCoords, unkIndices, texIndex, unkByte1, unkByte2 };
                totalChunkIndex++;
            }
            // } else {
            //     console.warn(`skipping szme data of index ${szmeOffs + 0x23}, has too many chunks`);
            // }

            // Read 'After SZME' array

            const afterSzmeCount = stream.readUint16();
            for (let afterSzmeI = 0; afterSzmeI < afterSzmeCount; afterSzmeI++) {
                const unkCount1 = stream.readUint8();
                stream.offs += unkCount1 * 4 * 3; // vec3

                const unkCount2 = stream.readUint8();
                stream.offs += unkCount2 * 4; // u32

                const unkCount3 = stream.readUint8();
                stream.offs += unkCount3; // u8

                stream.offs += unkCount1 * unkCount3 * 4; // float

                if (container.field0x40 != 0) {
                    // Read 'After SZME nested' array

                    const unkCount4 = stream.readUint8();
                    stream.offs += unkCount4 * 4 * 3; // vec3

                    stream.offs += unkCount1 * container.field0x40 * 2; // u16
                }
            }
        }

        this.szmeHeader = { position };
    }
}