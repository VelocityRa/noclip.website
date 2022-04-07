import { vec3, vec4 } from "gl-matrix";
import { NamedArrayBufferSlice } from "../DataFetcher";
import { DataStream } from "./DataStream";

export interface MaterialEntry {
    hasTex: boolean;
    isOpaque: boolean;

    colors: Array<vec4>;
    name: string;

    triStripList: Map<number, number>; // <start, count>
}

export interface VertexData {
    positions: Float32Array; // vec3
    normals: Float32Array; // vec3
    texcoords: Float32Array; // vec2
    // materialIds: Uint32Array; // uint

    // materials: Map<string, Map<number, number>>;
}

type AllTriStripLists = Map<string, Map<number, number>>;

export interface MeshWorld {
    vertexData: VertexData;
    // indexData: Uint16Array;
    materialEntries: MaterialEntry[];
    allTriStripLists: AllTriStripLists;

    bgColor: vec3;
}


function parseMaterialEntry(ds: DataStream, allTriStripLists: AllTriStripLists): MaterialEntry {
    const nameLen = ds.u32();
    const name = ds.readString(nameLen);
    const colors = [ds.vec4(), ds.vec4(), ds.vec4(), ds.vec4()];
    const unkf = ds.f32();
    const unku = ds.u32();
    const hasTex = ds.u32() != 0;

    let nameFinal = name;
    if (hasTex) {
        const texNameLen = ds.u32();
        const texName = ds.readString(texNameLen);

        nameFinal = texName; // TODO(velocity): HACKY
    }

    const triStripListLen = ds.u32();
    let triStripList = new Map<number, number>();
    for (let i = 0; i < triStripListLen; ++i) {
        const triStripListSize = ds.u32();
        const triStripListStart = ds.u32();

        triStripList.set(triStripListStart, triStripListSize);
    }

    if (!allTriStripLists.has(nameFinal))
        allTriStripLists.set(nameFinal, new Map<number, number>());

    const mergedList = new Map<number, number>([
        ...allTriStripLists.get(nameFinal)!.entries(),
        ...triStripList.entries()
    ]);
    allTriStripLists.set(nameFinal, mergedList);

    let isOpaque = true; // will be set later
    return { hasTex, isOpaque, colors, name: nameFinal, triStripList };
}

function parseMaterialNode(ds: DataStream, materialEntries: MaterialEntry[], allTriStripLists: AllTriStripLists) {
    ds.offs += 3 * 4 * 2; // AABBs

    const childrenCount = ds.u32();

    if (childrenCount == 0) {
        const allTriStripListsCount = ds.u32();

        for (let i = 0; i < allTriStripListsCount; ++i) {
            materialEntries.push(parseMaterialEntry(ds, allTriStripLists));
        }
    } else {
        for (let i = 0; i < childrenCount; ++i) {
            parseMaterialNode(ds, materialEntries, allTriStripLists);
        }
    }
}

export function parseMESHWORLD(buffer: NamedArrayBufferSlice): MeshWorld {
    let ds = new DataStream(buffer);

    const spotCount = ds.u32();
    for (let i = 0; i < spotCount; ++i) {
        const nameLen = ds.u32();
        const name = ds.readString(nameLen);
        ds.offs += 3 * 4 + 4 + 4 + 4;
        const containsOpt = ds.u32();
        if (containsOpt != 0) {
            ds.offs += 4 * 4 * 4 + 4 + 4;
            const containsOpt2 = ds.u32();
            if (containsOpt2 == 1) {
                const name2Len = ds.u32();
                const name2 = ds.readString(name2Len);
            }
        }
    }

    const unk0Count = ds.u32();
    for (let i = 0; i < unk0Count; ++i) {
        const nameLen = ds.u32();
        const name = ds.readString(nameLen);
        const unkVecCount = ds.u32();
        ds.offs += unkVecCount * 3 * 4;
    }

    const unk1Count = ds.u32();
    for (let i = 0; i < unk1Count; ++i) {
        const containsOpt = ds.u32();
        if (containsOpt == 0) {
            ds.vec3();
            ds.vec3();
            ds.vec3();
        }
    }

    const bgColor = ds.vec3();
    const unkColor = ds.vec3(); // ???

    const vertexCount = ds.u32();
    let positions = new Float32Array(vertexCount * 3);
    let normals = new Float32Array(vertexCount * 3);
    let texcoords = new Float32Array(vertexCount * 2);

    for (let i = 0; i < vertexCount; ++i) {
        positions[i * 3 + 0] = ds.f32();
        positions[i * 3 + 1] = ds.f32();
        positions[i * 3 + 2] = ds.f32();

        normals[i * 3 + 0] = ds.f32();
        normals[i * 3 + 1] = ds.f32();
        normals[i * 3 + 2] = ds.f32();

        texcoords[i * 2 + 0] = ds.f32();
        texcoords[i * 2 + 1] = ds.f32();
    }

    let materialEntries: MaterialEntry[] = [];
    let allTriStripLists = new Map();

    parseMaterialNode(ds, materialEntries, allTriStripLists);

    // debugger;

    let materialIds = new Uint32Array(0);
    let vertexData = { positions, normals, texcoords, materialIds }
    return { vertexData, materialEntries, allTriStripLists, bgColor };
}

// export function parseCACHED(buffer: NamedArrayBufferSlice): MeshWorld {
//     let ds = new DataStream(buffer);

//     ds.u32(); // 0xBEEF;
//     ds.u32(); // unk


//     const vertexCount = ds.u32();
//     let positions = new Float32Array(vertexCount * 3);
//     let normals = new Float32Array(vertexCount * 3);
//     let texcoords = new Float32Array(vertexCount * 2);

//     for (let i = 0; i < vertexCount; ++i) {
//         positions[i * 3 + 0] = ds.f32();
//         positions[i * 3 + 1] = ds.f32();
//         positions[i * 3 + 2] = ds.f32();

//         normals[i * 3 + 0] = ds.f32();
//         normals[i * 3 + 1] = ds.f32();
//         normals[i * 3 + 2] = ds.f32();

//         texcoords[i * 2 + 0] = ds.f32();
//         texcoords[i * 2 + 1] = ds.f32();
//     }

//     const indexCount = ds.u32();
//     let indexData = new Uint16Array(indexCount);
//     for (let i = 0; i < indexCount; ++i) {
//         indexData[i] = ds.u16();
//     }

//     const materialIdsCount = indexCount / 3;
//     let materialIds = new Uint32Array(materialIdsCount);
//     for (let i = 0; i < materialIdsCount; ++i) {
//         materialIds[i] = ds.u32();
//     }

//     let vertexData = { positions, normals, texcoords, materialIds }
//     return { vertexData, indexData };
// }
