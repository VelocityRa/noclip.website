import ArrayBufferSlice from '../ArrayBufferSlice';
import { vec2, vec3 } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { assert, hexzero, hexzero0x, leftPad } from '../util';
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end } from '../MathHelpers';
import * as Settings from './SlyConstants';

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

    public align(alignment: number) { this.offs += (-this.offs) & (alignment - 1); }
}

interface CLUTMetaEntry {
    colorCount: number;
    size: number;
    offset: number; // Relative to start of color palette data
}

export function parseCLUTMetaEntries(stream: DataStream): CLUTMetaEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<CLUTMetaEntry>();

    for (let i = 0; i < entryCount; ++i) {
        stream.offs += 4;
        const colorCount = stream.readUint16();
        const size = stream.readUint16();
        const offset = stream.readUint32();
        entries.push({ colorCount: colorCount, size: size, offset: offset });
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

        stream.offs += 0x14;
        let unk2 = stream.readUint16();
        if (unk2 > 0)
            stream.offs += 0x1C;

        entries.push({ clutIndices: clutIndices, imageIndices: imageIndices });
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

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class Texture {
    public texels_rgba: Uint8Array;
    public viewerTexture: Viewer.Texture[] = [];

    private static csm1ClutIndices = getCsm1ClutIndices();
    constructor(paletteBuf: ArrayBufferSlice, imageBuf: ArrayBufferSlice,
        public width: number, public height: number, colorCount: number, public name: string = "N/A") {

        // TODO
        this.texels_rgba = new Uint8Array(width * height * 4);

        let texels_slice = imageBuf.createTypedArray(Uint8Array);
        let palette_slice = paletteBuf.createTypedArray(Uint8Array);

        for (let i of range_end(0, width * height)) {
            let idx = texels_slice[i] * 4;
            if (colorCount == 256)
                idx = Texture.csm1ClutIndices[texels_slice[i]] * 4;

            // const x = i % width;
            // const y = Math.floor(i / width);
            // const inv_y = (-(y - (width / 2))) + width / 2 - 1;
            // const offs = (inv_y * width + x) * 4;
            const offs = i * 4;

            // const alpha = palette_slice[idx + 3] / 256; // Paint alpha black
            this.texels_rgba[offs + 0] = palette_slice[idx + 0];
            this.texels_rgba[offs + 1] = palette_slice[idx + 1];
            this.texels_rgba[offs + 2] = palette_slice[idx + 2];
            this.texels_rgba[offs + 3] = palette_slice[idx + 3]; // 0xFF; // palette_slice[idx + 3] * 2;
        }
    }

    public async toCanvas(): Promise<Viewer.Texture> {
        const canvas = document.createElement("canvas");
        const width = this.width;
        const height = this.height;
        canvas.width = width;
        canvas.height = height;
        canvas.title = this.name;

        // todo: flip here?

        const ctx = canvas.getContext("2d")!;
        const imgData = ctx.createImageData(canvas.width, canvas.height);
        imgData.data.set(this.texels_rgba);
        ctx.putImageData(imgData, 0, 0);
        const surfaces = [canvas];

        if (Settings.TEXTURES_EXPORT) {
            downloadCanvasAsPng(canvas, this.name);
            await sleep(100); // todo test
        }

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', 'IDTEX8-CSM1 (PS2)');


        return { name: this.name, surfaces, extraInfo };
    }
}

export interface SzmeChunk {
    unkVec: vec3;
    positions: Float32Array; // vec3
    rotations: Float32Array; // vec3
    unkColors: Uint32Array;  // RGBA
    texCoords: Float32Array; // vec2
    lighting: Uint32Array;   // RGBA
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
    unk_0x20: number;

    trianglesIndices: Uint16Array;
    unkIndices: Uint16Array;

    szme: SzmeChunk | undefined;
}

export class Mesh {
    static readonly szmsMagic = 0x534D5A53; // "SZMS"
    static readonly szmeMagic = 0x454d5a53; // "SZME"

    public chunks: MeshChunk[] = [];
    public szmeHeader: (SzmeHeader | undefined);

    constructor(buffer: ArrayBufferSlice, public offset: number, public index: number) {
        const view = buffer.createDataView(0);
        let stream = new DataStream(buffer, view);
        stream.offs = offset - 2;

        // Read SZMS header

        const flags = stream.readUint16();

        if (stream.readUint32() != Mesh.szmsMagic)
            throw new Error(`bad SZMS magic`);

        if (stream.readUint32() != 0x4)
            throw new Error(`unsupported version`);

        if ((flags & 1) != 0)
            throw new Error(`skipping mesh at ${hexzero0x(offset)}, has invalid flags: ${hexzero0x(flags)}`);

        const totalSize = stream.readUint32();

        const startOffs = stream.offs;

        // Read mesh header

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

            // Read vertices

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
            let unk_0x20 = 0;

            for (let i = 0; i < vertexCount; ++i) {
                positions[i * 3] = stream.readFloat32();
                positions[i * 3 + 1] = stream.readFloat32();
                positions[i * 3 + 2] = stream.readFloat32();

                normals[i * 3] = stream.readFloat32();
                normals[i * 3 + 1] = stream.readFloat32();
                normals[i * 3 + 2] = stream.readFloat32();

                texCoords[i * 2] = stream.readFloat32();
                texCoords[i * 2 + 1] = stream.readFloat32();

                unk_0x20 = stream.readUint32();
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
            if (index == 0)
                console.log(trianglesIndices);

            // Read index data

            stream.offs = startOffs + indexDataOffs2;
            let unkIndices = new Uint16Array(indexCount);

            for (let i of range_end(0, indexCount)) {
                unkIndices[i] = stream.readUint16();
            }

            let szme: (SzmeChunk | undefined) = undefined;
            this.chunks.push({ positions, normals, texCoords, unk_0x20, trianglesIndices, unkIndices, szme});
        }

        // Read SZME header

        const szmeOffs = stream.offs;

        if (stream.readUint32() != Mesh.szmeMagic)
            throw new Error(`bad SZME magic at ${hexzero0x(szmeOffs)}`);

        if ((flags & 2) != 0) {
            stream.readUint32();
        }
        if ((flags & 0x200) != 0) {
            stream.readFloat32();
        }
        if ((flags & 4) != 0) {
            stream.readFloat32();
        }
        if ((flags & 8) != 0) {
            stream.readFloat32();
        }
        if ((flags & 0x10) != 0) {
            stream.readFloat32();
        }
        if ((flags & 0x20) != 0) {
            stream.readFloat32();
        }
        if ((flags & 0x40) != 0) {
            // meta entry alt
            //Assert(false);
            console.warn(`skipping chunks at ${hexzero0x(stream.offs)}, 0x40 flags unsupported: ${hexzero0x(flags, 3)}`);
            stream.offs += 0x1C;
        }
        if ((flags & 0x80) != 0) {
            stream.readFloat32(); stream.readFloat32(); stream.readFloat32(); // vec3
            stream.readFloat32(); stream.readFloat32(); stream.readFloat32(); stream.readFloat32(); // vec4
        }

        if (((flags & 0x100) == 0)) {
            const position: vec3 = stream.readVec3();

            const unkFloat0x14 = stream.readFloat32();
            stream.readUint16();
            const unkByte0x1A = stream.readUint8();
            const unkByte0x1B = stream.readUint8();
            const unkByte0x1C = stream.readUint8();

            const szmeChunkCount = stream.readUint16();

            if (szmsChunkCount != szmeChunkCount)
                throw new Error(`szmsChunkCount(${szmsChunkCount}) != szmeChunkCount(${szmeChunkCount})`);

            // Read SZME chunks

            if (szmeChunkCount < 0xFF) {
                for (let szmeChunkIndex = 0; szmeChunkIndex < szmeChunkCount; ++szmeChunkIndex) {
                    const unkVec: vec3 = stream.readVec3();

                    const unkFloat = stream.readFloat32();
                    const unk_count1 = stream.readUint8();
                    const unk_count2 = stream.readUint8();
                    const unk_count3 = stream.readUint8();
                    const unk_count4 = stream.readUint8();
                    const unk_count5 = stream.readUint8();

                    stream.align(4);

                    let positions = new Float32Array(unk_count1 * 3);
                    for (let i = 0; i < unk_count1 * 3; i += 3) {
                        positions[i] = stream.readFloat32();
                        positions[i + 1] = stream.readFloat32();
                        positions[i + 2] = stream.readFloat32();
                    }

                    let rotations = new Float32Array(unk_count2 * 3);
                    for (let i = 0; i < unk_count2 * 3; i += 3) {
                        rotations[i] = stream.readFloat32();
                        rotations[i + 1] = stream.readFloat32();
                        rotations[i + 2] = stream.readFloat32();
                    }

                    let unkColors = new Uint32Array(unk_count3);
                    for (let i = 0; i < unk_count3; i++) {
                        unkColors[i] = stream.readUint32();
                    }

                    let texCoords = new Float32Array(unk_count4 * 2);
                    for (let i = 0; i < unk_count4 * 2; i += 2) {
                        texCoords[i] = stream.readFloat32();
                        texCoords[i + 1] = stream.readFloat32();
                    }

                    let lighting = new Uint32Array(unk_count5);
                    for (let i = 0; i < unk_count5; i++) {
                        lighting[i] = stream.readUint32();
                    }

                    let texIndex = stream.readUint16();

                    let unkByte1 = stream.readUint8();
                    let unkByte2 = stream.readUint8();

                    this.chunks[szmeChunkIndex].szme = { unkVec, positions, rotations, unkColors, texCoords, lighting, texIndex, unkByte1, unkByte2 };
                }
            } else {
                console.warn(`skipping szme data of index ${szmeOffs + 0x23}, has too many chunks`);
            }

            this.szmeHeader = { position };
        } else {
            console.warn(`skipping szme data at ${szmeOffs}, has invalid flags: ${hexzero0x(flags)}`);
        }
    }
}