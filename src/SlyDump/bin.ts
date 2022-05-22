import { mat4, vec4 } from "gl-matrix";

export interface VertexData {
    positions: Float32Array; // vec3
    normals: Float32Array; // vec3
    texcoords: Float32Array; // vec2
    diff: Float32Array; // vec4
    spec: Float32Array; // vec4
}

export interface DumpChunk {
    index: number;
    name: string;
    vertexData: VertexData;
    indexData: Uint16Array;
    textureName: string | null;
    textureIsOpaque: boolean;
    drawType: number;
    transformBranchBits: number;
    vc17: vec4;
    vc18: vec4;
    vc19_ambientColor: vec4;
    vc29: vec4;
    fc: Map<number, vec4>; // Fragment constants
    projMatrix: mat4;
}

interface ObjFaceVertex {
    vertexIndex: number;
    textureCoordsIndex: number;
    vertexNormalIndex: number;
}

interface ObjFace {
    material: string;
    group: string;
    smoothingGroup: number;
    vertices: ObjFaceVertex[];
}

// TODO: use Arrays
interface ObjModel {
    name: string;
    vertices: number[];
    textureCoords: number[];
    normals: number[];
    faces: ObjFace[];

    // Sly data
    vertexDiff: number[];
    vertexSpec: number[];
    hasFloatSpecDiff: boolean;
    drawType: number;
    transformBranchBits: number;
    vc17: number[];
    vc18: number[];
    vc19_ambientColor: number[];
    vc29: number[];
    fc: Map<number, vec4>; // Fragment constants
    projMatrix: mat4;
    textureIsOpaque: boolean;
}

interface ObjResult {
    models: ObjModel[];
    materials: Set<string>;
    materialLibraries: Set<string>;
}

export class ObjFile {
    private result: ObjResult;
    private currentMaterial: string;
    private currentGroup: string;
    private smoothingGroup: number;

    constructor(private fileContents: string, private defaultModelName: string = 'untitled') {
        this.reset();
    }

    public reset() {
        this.result = {
            models: [],
            materials: new Set<string>(),
            materialLibraries: new Set<string>()
        };
        this.currentMaterial = '';
        this.currentGroup = '';
        this.smoothingGroup = 0;
    }

    public parse(): ObjResult {
        this.reset();

        const stripComments = (lineString: string) => {
            const commentIndex = lineString.indexOf('#');
            if (commentIndex > -1) { return lineString.substring(0, commentIndex); }
            return lineString;
        };

        const lines = this.fileContents.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = stripComments(lines[i]);

            const lineItems = line.replace(/\s\s+/g, ' ').trim().split(' ');

            switch (lineItems[0].toLowerCase()) {
                case 'o': // Start A New Model
                    this.parseObject(lineItems);
                    break;
                case 'g': // Start a new polygon group
                    this.parseGroup(lineItems);
                    break;
                case 'v': // Define a vertex for the current model
                    this.parseVertexCoords(lineItems);
                    break;
                case 'vt': // Texture Coords
                    this.parseTextureCoords(lineItems);
                    break;
                case 'vn': // Define a vertex normal for the current model
                    this.parseVertexNormal(lineItems);
                    break;
                case 'v36':
                    this.parseV36(lineItems, false, false);
                    break;
                case 'v36s':
                    this.parseV36(lineItems, false, true);
                    break;
                case 'v36sn':
                    this.parseV36(lineItems, true, true);
                    break;
                case 'vc':
                    this.parseVc(lineItems);
                    break;
                case 'fc':
                    this.parseFc(lineItems);
                    break;
                case 's': // Smooth shading statement
                    this.parseSmoothShadingStatement(lineItems);
                    break;
                case 'f': // Define a Face/Polygon
                    this.parsePolygon(lineItems);
                    break;
                case 'mtllib': // Reference to a material library file (.mtl)
                    this.parseMtlLib(lineItems);
                    break;
                case 'usemtl': // Sets the current material to be applied to polygons defined from this point forward
                    this.parseUseMtl(lineItems);
                    break;
            }
        }

        return this.result;
    }

    private currentModel() {
        if (this.result.models.length == 0) {
            this.result.models.push({
                name: this.defaultModelName,
                vertices: [],
                textureCoords: [],
                normals: [],
                faces: [],
                vertexDiff: [],
                vertexSpec: [],
                hasFloatSpecDiff: false,
                drawType: 0,
                transformBranchBits: 0,
                vc17: [],
                vc18: [],
                vc19_ambientColor: [],
                vc29: [],
                fc: new Map(),
                projMatrix: mat4.create(),
                textureIsOpaque: false,
            });
            this.currentGroup = '';
            this.smoothingGroup = 0;
        }

        return this.result.models[this.result.models.length - 1];
    }

    private parseObject(lineItems: string[]) {
        const modelName = lineItems.length >= 2 ? lineItems[1] : this.defaultModelName;
        this.result.models.push({
            name: modelName,
            vertices: [],
            textureCoords: [],
            normals: [],
            faces: [],
            vertexDiff: [],
            vertexSpec: [],
            hasFloatSpecDiff: false,
            drawType: 0,
            transformBranchBits: 0,
            vc17: [],
            vc18: [],
            vc19_ambientColor: [],
            vc29: [],
            fc: new Map(),
            projMatrix: mat4.create(),
            textureIsOpaque: false,
        });
        this.currentGroup = '';
        this.smoothingGroup = 0;
    }

    private parseGroup(lineItems: string[]) {
        if (lineItems.length != 2) { throw 'Group statements must have exactly 1 argument (eg. g group1)'; }

        this.currentGroup = lineItems[1];
    }

    private parseVertexCoords(lineItems: string[]) {
        const x = lineItems.length >= 2 ? parseFloat(lineItems[1]) : 0.0;
        const y = lineItems.length >= 3 ? parseFloat(lineItems[2]) : 0.0;
        const z = lineItems.length >= 4 ? parseFloat(lineItems[3]) : 0.0;

        this.currentModel().vertices.push(x, y, z);
    }

    private parseTextureCoords(lineItems: string[]) {
        const u = lineItems.length >= 2 ? parseFloat(lineItems[1]) : 0.0;
        const v = lineItems.length >= 3 ? parseFloat(lineItems[2]) : 0.0;
        // const w = lineItems.length >= 4 ? parseFloat(lineItems[3]) : 0.0;

        // this.currentModel().textureCoords.push(u, v, w);
        this.currentModel().textureCoords.push(u, v);
    }

    private parseVertexNormal(lineItems: string[]) {
        const x = lineItems.length >= 2 ? parseFloat(lineItems[1]) : 0.0;
        const y = lineItems.length >= 3 ? parseFloat(lineItems[2]) : 0.0;
        const z = lineItems.length >= 4 ? parseFloat(lineItems[3]) : 0.0;

        this.currentModel().normals.push(x, y, z);
    }

    private parseV36(lineItems: string[], hasFloatSpecDiff: boolean, hasSpec: boolean) {
        let n = 1;

        const x = parseFloat(lineItems[n++]);
        const y = parseFloat(lineItems[n++]);
        const z = parseFloat(lineItems[n++]);
        this.currentModel().vertices.push(x, y, z);

        const u = parseFloat(lineItems[n++]);
        const v = parseFloat(lineItems[n++]);
        this.currentModel().textureCoords.push(u, v);

        if (hasFloatSpecDiff) {
            this.currentModel().hasFloatSpecDiff = true;

            const dx = parseFloat(lineItems[n++]);
            const dy = parseFloat(lineItems[n++]);
            const dz = parseFloat(lineItems[n++]);
            const dw = parseFloat(lineItems[n++]);
            this.currentModel().vertexDiff.push(dx, dy, dz, dw);
            const sx = parseFloat(lineItems[n++]);
            const sy = parseFloat(lineItems[n++]);
            const sz = parseFloat(lineItems[n++]);
            const sw = parseFloat(lineItems[n++]);
            this.currentModel().vertexSpec.push(sx, sy, sz, sw);
        } else {
            const vdiff = parseInt(lineItems[n++], 16);
            this.currentModel().vertexDiff.push(vdiff);
            if (hasSpec) {
                const vspec = parseInt(lineItems[n++], 16);
                this.currentModel().vertexSpec.push(vspec);
            }
        }
    }

    private parseVc(lineItems: string[]) {
        let n = 1;

        this.currentModel().drawType = parseInt(lineItems[n++]);
        this.currentModel().transformBranchBits = parseInt(lineItems[n++], 16);

        this.currentModel().vc17.push(parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]));
        this.currentModel().vc18.push(parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]));
        this.currentModel().vc19_ambientColor.push(parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]));
        this.currentModel().vc29.push(parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]), parseFloat(lineItems[n++]));

        this.currentModel().projMatrix = mat4.fromValues(
            parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),
            parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),
            parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),
            parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++]),parseFloat(lineItems[n++])
        );
    }

    private parseFc(lineItems: string[]) {
        let n = 1;

        const offset = parseInt(lineItems[n++]);
        const v = vec4.fromValues(
            parseFloat(lineItems[n++]),
            parseFloat(lineItems[n++]),
            parseFloat(lineItems[n++]),
            parseFloat(lineItems[n++]));
        this.currentModel().fc.set(offset, v);
    }

    private parsePolygon(lineItems: string[]) {
        const totalVertices = (lineItems.length - 1);
        if (totalVertices < 3) { throw (`Face statement has less than 3 vertices`); }

        const face: ObjFace = {
            material: this.currentMaterial,
            group: this.currentGroup,
            smoothingGroup: this.smoothingGroup,
            vertices: []
        };

        for (let i = 0; i < totalVertices; i += 1) {
            const vertexString = lineItems[i + 1];
            const vertexValues = vertexString.split('/');

            if (vertexValues.length < 1 || vertexValues.length > 3) { throw (`Too many values (separated by /) for a single vertex`); }

            let vertexIndex = 0;
            let textureCoordsIndex = 0;
            let vertexNormalIndex = 0;
            vertexIndex = parseInt(vertexValues[0]);
            if (vertexValues.length > 1 && (vertexValues[1] != '')) { textureCoordsIndex = parseInt(vertexValues[1]); }
            if (vertexValues.length > 2) { vertexNormalIndex = parseInt(vertexValues[2]); }

            // if (vertexIndex == 0) { throw 'Faces uses invalid vertex index of 0'; }

            // Negative vertex indices refer to the nth last defined vertex
            // convert these to postive indices for simplicity
            if (vertexIndex < 0) { vertexIndex = this.currentModel().vertices.length + 1 + vertexIndex; }

            face.vertices.push({
                vertexIndex,
                textureCoordsIndex,
                vertexNormalIndex
            });
        }
        this.currentModel().faces.push(face);
    }

    private parseMtlLib(lineItems: string[]) {
        if (lineItems.length >= 2) { this.result.materialLibraries.add(lineItems[1]); }
    }

    private parseUseMtl(lineItems: string[]) {
        if (lineItems.length >= 2) {
            this.currentMaterial = lineItems[1];
            if (lineItems.length >= 3)
                this.currentModel().textureIsOpaque = (lineItems[2] == "1");
            else
                this.currentModel().textureIsOpaque = true;
            this.result.materials.add(this.currentMaterial);
        }
    }

    private parseSmoothShadingStatement(lineItems: string[]) {
        if (lineItems.length != 2) { throw 'Smoothing group statements must have exactly 1 argument (eg. s <number|off>)'; }

        const groupNumber = (lineItems[1].toLowerCase() == 'off') ? 0 : parseInt(lineItems[1]);
        this.smoothingGroup = groupNumber;
    }

}

export function parseDump(obj: ObjResult): DumpChunk[] {
    let dumpChunks = new Array<DumpChunk>();
    for (let model of obj.models) {
        if (model.vertices.length == 0)
            continue;

        let diffArray: Float32Array;
        let specArray: Float32Array;
        if (model.hasFloatSpecDiff) {
            diffArray = new Float32Array(model.vertexDiff);
            specArray = new Float32Array(model.vertexSpec);
        } else {
            diffArray = new Float32Array(model.vertexDiff.length * 4);
            for (let i = 0; i < model.vertexDiff.length; ++i) {
                const n = model.vertexDiff[i];
                diffArray[i * 4 + 3] = ((n & 0xFF000000) >>> 24) / 255.0;
                diffArray[i * 4 + 2] = ((n & 0x00FF0000) >>> 16) / 255.0;
                diffArray[i * 4 + 1] = ((n & 0x0000FF00) >>> 8) / 255.0;
                diffArray[i * 4 + 0] = ((n & 0x000000FF) >>> 0) / 255.0;
            }

            specArray = new Float32Array(model.vertexSpec.length * 4);
            for (let i = 0; i < model.vertexSpec.length; ++i) {
                const n = model.vertexSpec[i];
                specArray[i * 4 + 3] = ((n & 0xFF000000) >>> 24) / 255.0;
                specArray[i * 4 + 2] = ((n & 0x00FF0000) >>> 16) / 255.0;
                specArray[i * 4 + 1] = ((n & 0x0000FF00) >>> 8) / 255.0;
                specArray[i * 4 + 0] = ((n & 0x000000FF) >>> 0) / 255.0;
            }
        }

        const vertexData: VertexData = {
            positions: Float32Array.from(model.vertices),
            normals: Float32Array.from(model.normals),
            texcoords: Float32Array.from(model.textureCoords),
            diff: diffArray,
            spec: specArray
        };

        // TODO: Simplification
        let indices = new Uint16Array(model.faces.length * 3);
        for (let i = 0; i < model.faces.length; i++) {
            indices[i*3+0] = model.faces[i].vertices[0].vertexIndex;
            indices[i*3+1] = model.faces[i].vertices[1].vertexIndex;
            indices[i*3+2] = model.faces[i].vertices[2].vertexIndex;
        }
        // TODO: Simplification
        const textureName = model.faces.length > 0 ? model.faces[0].material : null;

        let drawType = model.drawType;
        let transformBranchBits = model.transformBranchBits;

        const vc17 = vec4.fromValues(model.vc17[0], model.vc17[1], model.vc17[2], model.vc17[3]);
        const vc18 = vec4.fromValues(model.vc18[0],model.vc18[1],model.vc18[2],model.vc18[3]);
        const vc19_ambientColor = vec4.fromValues(model.vc19_ambientColor[0], model.vc19_ambientColor[1], model.vc19_ambientColor[2], model.vc19_ambientColor[3]);
        const vc29 = vec4.fromValues(model.vc29[0], model.vc29[1], model.vc29[2], model.vc29[3]);

        let projMatrix = model.projMatrix;

        const textureIsOpaque = model.textureIsOpaque;

        const index = parseInt(model.name.split("_", 1)[0]);

        const fc = model.fc;

        dumpChunks.push({
            index, name: model.name, vertexData, indexData: indices, textureName, drawType,
            transformBranchBits, vc17, vc18, vc19_ambientColor, vc29, fc, projMatrix, textureIsOpaque
        });
    }

    return dumpChunks;
}
