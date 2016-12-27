---
title: setjmp/longjmp in Rust
date: 2016-12-21 16:45:26
tags:
- Rust
---

`setjmp`/`longjmp` is used for [no-local jumps](https://en.wikipedia.org/wiki/Setjmp.h), which means to 'jump' between different functions.

`setjmp` is used to declare a place (which is identified by an integer id) to jump to, while `longjmp` actually jumps to a place with a `value`. Generally if `setjmp` returns an `value`, it means that a no-local jump has occurred at this place.

This technique is generally used for exception handling, it allows the program to kind of 'rollback' through the stack to some point the exception not has happened. Complex and dangerous (unexpected behaviour & memory leaks) as these functions are, they are avoided mostly in modern code bases.

Recently I am using [libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) bindings in Rust, which uses this technique for error handling. I'd like to share some experiences about dealing with libjpeg in Rust.

## Error handling in Libjpeg

Libjpeg uses a `jpeg_err_mgr` struct for error handling related stuff. The struct contains error messages, code, stack and a pointer named `error_exit` to a callback function. You could call `jpeg_std_err()` to initialize the struct.

If you do not assign a function to `error_exit`, libjpeg will terminate the process when error occurs. In Rust, this means the whole thread will shut down. You could use the [catch_unwind](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html_) feature which is added to stable channel recently.

```rust
fn read_jpeg(input_buffer: &[u8], target_width: u32, target_height: u32) -> stdio::Result<Vec<u8>> {
	catch_unwind(AssertUnwindSafe(|| {
		unsafe {
			let mut dinfo: jpeg_decompress_struct = mem::zeroed();
			let size = mem::size_of_val(&dinfo) as size_t;

			let mut err: jpeg_error_mgr = mem::zeroed();
			dinfo.common.err = jpeg_std_error(&mut err);
			err.error_exit = Some(libjpeg_error_handler);
			jpeg_CreateDecompress(&mut dinfo, JPEG_LIB_VERSION, size);

			jpeg_mem_src(&mut dinfo, input_buffer.as_ptr(), input_buffer.len() as u64);
			jpeg_read_header(&mut dinfo, true as i32);
			let image_width = dinfo.image_width;
			let image_height = dinfo.image_height;
			if target_width != image_width || target_height != image_height {
				let (scale, scale_denom) = select_decompress_idct_factor(image_width, image_height, target_width, target_height);
				dinfo.scale_num = scale;
				dinfo.scale_denom = scale_denom;
			}
			dinfo.dct_method = J_DCT_METHOD::JDCT_IFAST;
			dinfo.do_fancy_upsampling = 0;
			dinfo.two_pass_quantize = 0;
			dinfo.dither_mode = J_DITHER_MODE::JDITHER_ORDERED;
			jpeg_start_decompress(&mut dinfo);

			let mut output_image = vec![0; (dinfo.output_width * dinfo.output_height * 3) as usize];
			let output_buffer = output_image.as_mut_ptr();
			let row_stride:u64 = dinfo.output_width as u64 * 3;
			let mut buffer = malloc(row_stride as usize) as *mut u8;
			while dinfo.output_scanline < dinfo.output_height {
				jpeg_read_scanlines(&mut dinfo, &mut buffer, 1);
				let output_row = &output_buffer.offset((dinfo.output_scanline as isize - 1) * row_stride as isize);
				ptr::copy(buffer, *output_row, row_stride as usize);
			}

			jpeg_finish_decompress(&mut dinfo);
			jpeg_destroy_decompress(&mut dinfo);
			// fclose(infile);
			free(buffer as *mut c_void);
			output_image.chunks(3).collect::<Vec<_>>().into_iter().flat_map(|pixel| {
                vec![pixel[0], pixel[1], pixel[2], 255].into_iter()
            }).collect::<Vec<_>>()
		}
	})).map_err(|e| {
		std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{:?}", e))
	})
}
```

However, `catch_unwind` will try to restore the thread with its stack, which could slow down the program. Also it's not recommanded for a general try/catch situation. A better way is to use `setjmp`/`longjmp` in Rust FFI.

## No-local jump in FFI

First we should declare extern C binding for the two functions.

```rust
extern {
	fn setjmp(env: *mut c_void) -> c_int;
	fn longjmp(env: *mut c_void, val: c_int);
}
```

No-local jump needs a buffer to store the stack. Create a struct to store the buffer. We will name it `my_error_mgr`. To make this easier, the struct is not handling error messages.

```rust
#[allow(non_camel_case_types)]
struct my_error_mgr {
	pub err_mgr: jpeg_error_mgr,
	pub setjmp_buffer: *mut c_void
}
```

To use the custom error manager, we need to pass `my_error_mgr.err_mgr` to `jpeg_std_err` to initialize.

```rust
let mut setjmp_buffer: [c_int; 27] = [0; 27];
let mut my_err = my_error_mgr { err_mgr: err, setjmp_buffer: mem::transmute(&mut setjmp_buffer) };
dinfo.common.err = jpeg_std_error(&mut my_err.err_mgr);
```

Next step is to create a function for error handling, bind it to the `err_mgr`. The handler will simply jump with value `1`.

```rust
// declare the function somewhere before
extern "C" fn libjpeg_error_handler(c_info: &mut jpeg_common_struct) {
	let my_err: *mut my_error_mgr = c_info.err as *mut my_error_mgr;
	unsafe { longjmp((*my_err).setjmp_buffer, 1); }
}

my_err.err_mgr.error_exit = Some(libjpeg_error_handler);
```

we will check `setjmp` before the decoding process begins, if an expection did occur, return an `Err` and prevent the crash.

```rust
if setjmp(my_err.setjmp_buffer) != 0 {
    jpeg_destroy_decompress(&mut dinfo);
    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "jpeg decode error"));
}
```

The complete example:

```rust
extern "C" fn libjpeg_error_handler(c_info: &mut jpeg_common_struct) {
	let my_err: *mut my_error_mgr = c_info.err as *mut my_error_mgr;
	unsafe { longjmp((*my_err).setjmp_buffer, 1); }
}
#[allow(non_camel_case_types)]
struct my_error_mgr {
	pub err_mgr: jpeg_error_mgr,
	pub setjmp_buffer: *mut c_void
}
extern {
	fn setjmp(env: *mut c_void) -> c_int;
	fn longjmp(env: *mut c_void, val: c_int);
}
fn read_jpeg(input_buffer: &[u8], target_width: u32, target_height: u32) -> stdio::Result<Vec<u8>> {
	unsafe {
		let mut dinfo: jpeg_decompress_struct = mem::zeroed();
		let size = mem::size_of_val(&dinfo) as size_t;

		let mut err: jpeg_error_mgr = mem::zeroed();
		let mut setjmp_buffer: [c_int; 27] = [0; 27];
		let mut my_err = my_error_mgr { err_mgr: err, setjmp_buffer: mem::transmute(&mut setjmp_buffer) };
		dinfo.common.err = jpeg_std_error(&mut my_err.err_mgr);
		my_err.err_mgr.error_exit = Some(libjpeg_error_handler);
		if setjmp(my_err.setjmp_buffer) != 0 {
			jpeg_destroy_decompress(&mut dinfo);
			return Err(stdio::Error::new(stdio::ErrorKind::InvalidData, "jpeg decode error"));
		}
		jpeg_CreateDecompress(&mut dinfo, JPEG_LIB_VERSION, size);
		jpeg_mem_src(&mut dinfo, input_buffer.as_ptr(), input_buffer.len() as u64);
		jpeg_read_header(&mut dinfo, true as i32);
		let image_width = dinfo.image_width;
		let image_height = dinfo.image_height;
		if target_width != image_width || target_height != image_height {
			let (scale, scale_denom) = select_decompress_idct_factor(image_width, image_height, target_width, target_height);
			dinfo.scale_num = scale;
			dinfo.scale_denom = scale_denom;
		}
		dinfo.dct_method = J_DCT_METHOD::JDCT_IFAST;
		dinfo.do_fancy_upsampling = 0;
		dinfo.two_pass_quantize = 0;
		dinfo.dither_mode = J_DITHER_MODE::JDITHER_ORDERED;
		jpeg_start_decompress(&mut dinfo);

		let mut output_image = vec![0; (dinfo.output_width * dinfo.output_height * 3) as usize];
		let output_buffer = output_image.as_mut_ptr();
		let row_stride:u64 = dinfo.output_width as u64 * 3;
		let mut buffer = malloc(row_stride as usize) as *mut u8;
		while dinfo.output_scanline < dinfo.output_height {
			jpeg_read_scanlines(&mut dinfo, &mut buffer, 1);
			let output_row = &output_buffer.offset((dinfo.output_scanline as isize - 1) * row_stride as isize);
			ptr::copy(buffer, *output_row, row_stride as usize);
		}

		jpeg_finish_decompress(&mut dinfo);
		jpeg_destroy_decompress(&mut dinfo);
		// fclose(infile);
		free(buffer as *mut c_void);
		let alpha = &[255];
		let output_image = output_image.chunks(3).flat_map(|chunk| {
			chunk.into_iter().chain(alpha)
		}).map(|i| *i).collect::<Vec<_>>();
        Ok(output_image)
	}
}
```