import ArrayBufferSlice from '../ArrayBufferSlice';
import { vec2, vec3, vec4, mat4 } from "gl-matrix";

export class DataStream {
    constructor(
        public buffer: ArrayBufferSlice,
        public view: DataView = buffer.createDataView(),
        public offs: number = 0,
        private dec = new TextDecoder(),
    ) {
    }

    public readUint8(): number { return this.view.getUint8(this.offs++); }
    public readUint16(): number { const v = this.view.getUint16(this.offs, true); this.offs += 2; return v; }
    public readUint32(): number { const v = this.view.getUint32(this.offs, true); this.offs += 4; return v; }
    public readFloat32(): number { const v = this.view.getFloat32(this.offs, true); this.offs += 4; return v; }
    public readFloat64(): number { const v = this.view.getFloat64(this.offs, true); this.offs += 8; return v; }
    public readVec2(): vec2 { return vec2.fromValues(this.readFloat32(), this.readFloat32()); }
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

    public readString(size: number): string {
        let view = this.buffer.slice(this.offs, this.offs + size).createTypedArray(Uint8Array);
        let str = this.dec.decode(view);
        let nullIdx = str.indexOf('\0');
        if (nullIdx != -1)
            str = str.substr(0, nullIdx); // Trim trailing null terminators
        this.offs += size;
        return str;
    }

    public readUint8At(offset: number): number { return this.view.getUint8(offset); }
    public readUint16At(offset: number): number { return this.view.getUint16(offset, true); }
    public readUint32At(offset: number): number { return this.view.getUint32(offset, true); }

    public align(alignment: number) { this.offs += (-this.offs) & (alignment - 1); }
    public skip(size: number) { this.offs += size; }

    // Shorthands

    public u8(): number { return this.readUint8(); }
    public u16(): number { return this.readUint16(); }
    public u32(): number { return this.readUint32(); }
    public f32(): number { return this.readFloat32(); }
    public f64(): number { return this.readFloat64(); }
    public vec3(): vec3 { return this.readVec3(); }
    public vec4(): vec4 { return this.readVec4(); }
    public mat4(): mat4 { return this.readMat4(); }

    public str(size: number): string { return this.readString(size); }

    public u8At(offset: number): number { return this.readUint8At(offset); }
    public u16At(offset: number): number { return this.readUint16At(offset); }
    public u32At(offset: number): number { return this.readUint32At(offset); }
}
